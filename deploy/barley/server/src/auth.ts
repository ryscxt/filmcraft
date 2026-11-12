// Passkey (WebAuthn) sign-in. Three ways to register a passkey:
//   setup  - the first admin, with SETUP_TOKEN, only while there are no users;
//   invite - a new person, with a one-time invite link an admin made;
//   add    - another passkey (device) for the signed-in person.
// Sign-in uses discoverable credentials: no user name, the authenticator offers its passkeys.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Config } from "./config.ts";
import { type Store, type User, token } from "./db.ts";
import { HttpError, cookies, json, readJson, sessionCookie } from "./http.ts";

export const SESSION_COOKIE = "fc_session";

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const cleanName = (s: unknown) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);

export class Auth {
  cfg: Config;
  store: Store;
  constructor(cfg: Config, store: Store) {
    this.cfg = cfg;
    this.store = store;
  }

  get secure() {
    return this.cfg.origin.startsWith("https://");
  }

  /** The signed-in user for this request, if any. */
  user(req: IncomingMessage): User | undefined {
    const t = cookies(req)[SESSION_COOKIE];
    return t ? this.store.sessionUser(t, this.cfg.sessionDays) : undefined;
  }

  private startSession(res: ServerResponse, userId: string, body: unknown) {
    const t = this.store.createSession(userId, this.cfg.sessionDays);
    json(res, 200, body, { "Set-Cookie": sessionCookie(SESSION_COOKIE, t, this.cfg.sessionDays * 86_400, this.secure) });
  }

  private async registrationOptions(user: { id: string; name: string }, exclude: { id: string; transports: string }[]) {
    return generateRegistrationOptions({
      rpName: this.cfg.rpName,
      rpID: this.cfg.rpId,
      userName: user.name,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: exclude.map((c) => ({ id: c.id, transports: (c.transports ? c.transports.split(",") : []) as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
  }

  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    const m = req.method;
    if (p === "/api/auth/status" && m === "GET") {
      const u = this.user(req);
      json(res, 200, { needsSetup: this.store.userCount() === 0, signedIn: !!u, name: u?.name ?? null });
      return true;
    }
    if (p === "/api/auth/invite" && m === "GET") {
      const inv = this.store.invite(url.searchParams.get("token") ?? "");
      if (!inv) throw new HttpError(404, "this invite link is not valid any more");
      json(res, 200, { ok: true, note: inv.note });
      return true;
    }
    if (p === "/api/auth/register/options" && m === "POST") {
      const b = await readJson(req);
      const mode = String(b.mode ?? "");
      let user: { id: string; name: string };
      let exclude: { id: string; transports: string }[] = [];
      const data: Record<string, unknown> = { mode };
      if (mode === "setup") {
        if (this.store.userCount() > 0) throw new HttpError(409, "FilmCraft is already set up: sign in instead");
        if (!this.cfg.setupToken || !sameSecret(String(b.token ?? ""), this.cfg.setupToken)) throw new HttpError(403, "wrong setup token");
        const name = cleanName(b.name);
        if (!name) throw new HttpError(400, "enter your name");
        user = { id: token(16), name };
      } else if (mode === "invite") {
        const t = String(b.token ?? "");
        if (!this.store.invite(t)) throw new HttpError(403, "this invite link is not valid any more");
        const name = cleanName(b.name);
        if (!name) throw new HttpError(400, "enter your name");
        user = { id: token(16), name };
        data.invite = t;
      } else if (mode === "add") {
        const u = this.user(req);
        if (!u) throw new HttpError(401, "sign in first");
        user = u;
        exclude = this.store.credentialsOf(u.id);
      } else {
        throw new HttpError(400, "unknown mode");
      }
      data.user = user;
      data.label = cleanName(b.label);
      const options = await this.registrationOptions(user, exclude);
      json(res, 200, { flow: this.store.putChallenge(options.challenge, "register", data), options });
      return true;
    }
    if (p === "/api/auth/register/verify" && m === "POST") {
      const b = await readJson(req);
      const flow = this.store.takeChallenge(String(b.flow ?? ""), "register");
      if (!flow) throw new HttpError(400, "the request expired, try again");
      const { mode, user, invite, label } = flow.data as { mode: string; user: { id: string; name: string }; invite?: string; label: string };
      let v;
      try {
        v = await verifyRegistrationResponse({
          response: b.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: this.cfg.origin,
          expectedRPID: this.cfg.rpId,
          requireUserVerification: false,
        });
      } catch (e) {
        throw new HttpError(400, `passkey not accepted: ${(e as Error).message}`);
      }
      if (!v.verified || !v.registrationInfo) throw new HttpError(400, "passkey not accepted");
      const c = v.registrationInfo.credential;
      if (this.store.credential(c.id)) throw new HttpError(409, "this passkey is already registered");
      const save = (userId: string) =>
        this.store.addCredential({ id: c.id, user_id: userId, public_key: c.publicKey, counter: c.counter, transports: (c.transports ?? []).join(","), label: label || "Passkey" });
      if (mode === "add") {
        const u = this.user(req);
        if (!u || u.id !== user.id) throw new HttpError(401, "sign in first");
        save(u.id);
        json(res, 200, { ok: true });
        return true;
      }
      // setup and invite create the person; the check and the insert run in one transaction so
      // two people racing for the same setup or invite cannot both get in
      let created: User | undefined;
      this.store.db.exec("BEGIN IMMEDIATE");
      try {
        if (mode === "setup" && this.store.userCount() > 0) throw new HttpError(409, "FilmCraft is already set up: sign in instead");
        // the id the passkey was made for (its user handle)
        created = this.store.createUser(user.name, mode === "setup", user.id);
        if (mode === "invite" && !this.store.useInvite(String(invite), user.id)) throw new HttpError(403, "this invite link is not valid any more");
        save(user.id);
        this.store.db.exec("COMMIT");
      } catch (e) {
        this.store.db.exec("ROLLBACK");
        throw e;
      }
      this.startSession(res, created.id, { ok: true, name: created.name });
      return true;
    }
    if (p === "/api/auth/login/options" && m === "POST") {
      const options = await generateAuthenticationOptions({ rpID: this.cfg.rpId, userVerification: "preferred", allowCredentials: [] });
      json(res, 200, { flow: this.store.putChallenge(options.challenge, "login", {}), options });
      return true;
    }
    if (p === "/api/auth/login/verify" && m === "POST") {
      const b = await readJson(req);
      const flow = this.store.takeChallenge(String(b.flow ?? ""), "login");
      if (!flow) throw new HttpError(400, "the request expired, try again");
      const cred = this.store.credential(String(b.response?.id ?? ""));
      if (!cred) throw new HttpError(401, "this passkey is not registered here");
      let v;
      try {
        v = await verifyAuthenticationResponse({
          response: b.response,
          expectedChallenge: flow.challenge,
          expectedOrigin: this.cfg.origin,
          expectedRPID: this.cfg.rpId,
          credential: {
            id: cred.id,
            publicKey: new Uint8Array(cred.public_key),
            counter: cred.counter,
            transports: (cred.transports ? cred.transports.split(",") : []) as AuthenticatorTransportFuture[],
          },
          requireUserVerification: false,
        });
      } catch (e) {
        throw new HttpError(401, `sign-in failed: ${(e as Error).message}`);
      }
      if (!v.verified) throw new HttpError(401, "sign-in failed");
      this.store.touchCredential(cred.id, v.authenticationInfo.newCounter);
      const u = this.store.user(cred.user_id);
      if (!u) throw new HttpError(401, "this person no longer has access");
      this.startSession(res, u.id, { ok: true, name: u.name });
      return true;
    }
    if (p === "/api/auth/logout" && m === "POST") {
      const t = cookies(req)[SESSION_COOKIE];
      if (t) this.store.deleteSession(t);
      json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(SESSION_COOKIE, "", 0, this.secure) });
      return true;
    }
    return false;
  }
}

/** Account and admin routes for a signed-in user. */
export async function accountRoutes(req: IncomingMessage, res: ServerResponse, url: URL, user: User, store: Store, cfg: Config): Promise<boolean> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/api/me" && m === "GET") {
    const creds = store.credentialsOf(user.id).map((c) => ({ id: c.id, label: c.label, created_at: c.created_at, last_used_at: c.last_used_at }));
    json(res, 200, { id: user.id, name: user.name, admin: !!user.is_admin, passkeys: creds });
    return true;
  }
  const mc = /^\/api\/me\/passkeys\/([^/]+)$/.exec(p);
  if (mc && m === "DELETE") {
    if (store.credentialsOf(user.id).length <= 1) throw new HttpError(409, "you cannot remove your last passkey");
    if (!store.deleteCredential(user.id, decodeURIComponent(mc[1]!))) throw new HttpError(404, "no such passkey");
    json(res, 200, { ok: true });
    return true;
  }
  if (!p.startsWith("/api/users") && !p.startsWith("/api/invites")) return false;
  if (!user.is_admin) throw new HttpError(403, "only an admin can do that");
  if (p === "/api/users" && m === "GET") {
    json(res, 200, { users: store.users().map((u) => ({ id: u.id, name: u.name, admin: !!u.is_admin, passkeys: u.passkeys, created_at: u.created_at, last_used_at: u.last_used_at })) });
    return true;
  }
  const mu = /^\/api\/users\/([^/]+)$/.exec(p);
  if (mu && m === "DELETE") {
    const id = decodeURIComponent(mu[1]!);
    if (id === user.id) throw new HttpError(409, "you cannot remove yourself");
    store.deleteSessionsOf(id);
    store.deleteUser(id);
    json(res, 200, { ok: true });
    return true;
  }
  if (p === "/api/invites" && m === "GET") {
    json(res, 200, { invites: store.invites() });
    return true;
  }
  if (p === "/api/invites" && m === "POST") {
    const b = await readJson(req);
    const inv = store.createInvite(user.id, cleanName(b.note), cfg.inviteHours);
    json(res, 200, { id: inv.id, url: `${cfg.origin}/invite#${inv.token}`, expires_at: inv.expires_at });
    return true;
  }
  const mi = /^\/api\/invites\/([^/]+)$/.exec(p);
  if (mi && m === "DELETE") {
    store.deleteInvite(decodeURIComponent(mi[1]!));
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

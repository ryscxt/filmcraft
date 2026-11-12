import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/main.ts";
import { loadConfig } from "../src/config.ts";
import { cleanRel, resolveIn } from "../src/paths.ts";
import { SoftPasskey } from "./authenticator.ts";

const ORIGIN = "http://localhost";
const SETUP = "test-setup-token-123";
let base = "";
let dataDir = "";
let close: () => void;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-host-"));
  const cfg = loadConfig({ DATA_DIR: dataDir, ORIGIN, SETUP_TOKEN: SETUP, DIST_DIR: path.join(dataDir, "dist"), TRUST_PROXY: "1" });
  const { server } = createServer(cfg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => {
  close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A browser-ish client: keeps its cookie, sends our Origin on writes. */
class Client {
  cookie = "";
  ip: string;
  constructor(ip = "10.0.0.1") {
    this.ip = ip;
  }
  async req(p: string, init: { method?: string; body?: unknown; raw?: Buffer | string; headers?: Record<string, string>; origin?: string } = {}) {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { "X-Forwarded-For": this.ip, ...init.headers };
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== "GET" && method !== "HEAD") headers.Origin = init.origin ?? ORIGIN;
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    } else if (init.raw !== undefined) body = typeof init.raw === "string" ? init.raw : new Uint8Array(init.raw);
    const res = await fetch(base + p, { method, headers, body, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    return res;
  }
  async json(p: string, init: Parameters<Client["req"]>[1] = {}) {
    const res = await this.req(p, init);
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any, res };
  }
  async register(mode: string, extra: object, key: SoftPasskey) {
    const o = await this.json("/api/auth/register/options", { method: "POST", body: { mode, ...extra } });
    if (o.status !== 200) return o;
    return this.json("/api/auth/register/verify", { method: "POST", body: { flow: o.data.flow, response: key.create(o.data.options) } });
  }
  async login(key: SoftPasskey, origin?: string) {
    const o = await this.json("/api/auth/login/options", { method: "POST" });
    return this.json("/api/auth/login/verify", { method: "POST", body: { flow: o.data.flow, response: key.get(o.data.options, origin) } });
  }
}

const admin = new Client();
const adminKey = new SoftPasskey(ORIGIN, "localhost");

test("paths never leave the files folder", () => {
  assert.equal(cleanRel("a//b/c.mp4"), "a/b/c.mp4");
  for (const bad of ["../x", "a/../../x", "a/./b", "a\\b", "a\0b", ".fc-upload-x"]) assert.throws(() => cleanRel(bad), bad);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fc-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fc-out-"));
  fs.symlinkSync(outside, path.join(root, "link"));
  assert.throws(() => resolveIn(root, "link/secret.txt"), /leaves/);
  assert.equal(resolveIn(root, "ok/new.txt"), path.join(fs.realpathSync(root), "ok/new.txt"));
});

test("everything but sign-in needs a session", async () => {
  const anon = new Client("10.0.0.9");
  assert.equal((await anon.json("/api/files")).status, 401);
  const page = await anon.req("/");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/setup");
  assert.deepEqual((await anon.json("/api/auth/status")).data, { needsSetup: true, signedIn: false, name: null });
});

test("setup needs the token, then makes the first admin once", async () => {
  const bad = await new Client("10.0.0.2").register("setup", { token: "nope", name: "Ryś" }, new SoftPasskey(ORIGIN, "localhost"));
  assert.equal(bad.status, 403);
  const ok = await admin.register("setup", { token: SETUP, name: "Ryś" }, adminKey);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.name, "Ryś");
  const me = await admin.json("/api/me");
  assert.equal(me.data.admin, true);
  const again = await new Client("10.0.0.3").register("setup", { token: SETUP, name: "Eve" }, new SoftPasskey(ORIGIN, "localhost"));
  assert.equal(again.status, 409);
});

test("sign-in with the passkey; a wrong origin is refused", async () => {
  const c = new Client("10.0.0.4");
  const bad = await c.login(adminKey, "https://evil.example");
  assert.equal(bad.status, 401);
  const ok = await c.login(adminKey);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await c.json("/api/me")).data.name, "Ryś");
  await c.json("/api/auth/logout", { method: "POST" });
  assert.equal((await c.json("/api/me")).status, 401);
});

test("an unknown passkey cannot sign in", async () => {
  const r = await new Client("10.0.0.5").login(new SoftPasskey(ORIGIN, "localhost"));
  assert.equal(r.status, 401);
});

test("invites are one-time and make a non-admin", async () => {
  const inv = await admin.json("/api/invites", { method: "POST", body: { note: "Ola" } });
  assert.equal(inv.status, 200);
  const token = new URL(inv.data.url).hash.slice(1);
  const ola = new Client("10.0.0.6");
  const olaKey = new SoftPasskey(ORIGIN, "localhost");
  const r = await ola.register("invite", { token, name: "Ola" }, olaKey);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await ola.json("/api/me")).data.admin, false);
  assert.equal((await ola.json("/api/users")).status, 403);
  const reuse = await new Client("10.0.0.7").register("invite", { token, name: "Mallory" }, new SoftPasskey(ORIGIN, "localhost"));
  assert.equal(reuse.status, 403);
  // an admin can take access away: sessions and passkeys go
  const users = (await admin.json("/api/users")).data.users;
  const id = users.find((u: any) => u.name === "Ola").id;
  assert.equal((await admin.json(`/api/users/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await ola.json("/api/me")).status, 401);
  assert.equal((await new Client("10.0.0.8").login(olaKey)).status, 401);
});

test("a second passkey can be added; the last one cannot be removed", async () => {
  const second = new SoftPasskey(ORIGIN, "localhost");
  const r = await admin.register("add", { label: "Telefon" }, second);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const keys = (await admin.json("/api/me")).data.passkeys;
  assert.equal(keys.length, 2);
  assert.equal((await admin.json(`/api/me/passkeys/${keys[1].id}`, { method: "DELETE" })).status, 200);
  assert.equal((await admin.json(`/api/me/passkeys/${keys[0].id}`, { method: "DELETE" })).status, 409);
});

test("writes from another origin are refused", async () => {
  const r = await admin.json("/api/files/mkdir", { method: "POST", body: { path: "x" }, origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("files: upload, list, range reads, conflicts, move, trash", async () => {
  const data = Buffer.from("0123456789abcdef".repeat(1000));
  const put = await admin.json("/api/files/raw/Trailer/clip%2001.mp4", { method: "PUT", raw: data });
  assert.equal(put.status, 200);
  assert.equal(put.data.size, data.length);

  const list = await admin.json("/api/files?dir=Trailer");
  assert.equal(list.data.entries[0].name, "clip 01.mp4");
  const all = await admin.json("/api/files?recursive=1");
  assert.deepEqual(all.data.entries.map((e: any) => e.path), ["Trailer", "Trailer/clip 01.mp4"]);

  const part = await admin.req("/api/files/raw/Trailer/clip%2001.mp4", { headers: { Range: "bytes=16-31" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 16-31/${data.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), "0123456789abcdef");
  const tail = await admin.req("/api/files/raw/Trailer/clip%2001.mp4", { headers: { Range: "bytes=-4" } });
  assert.equal(Buffer.from(await tail.arrayBuffer()).toString(), "cdef");
  const past = await admin.req("/api/files/raw/Trailer/clip%2001.mp4", { headers: { Range: `bytes=${data.length}-` } });
  assert.equal(past.status, 416);
  await past.arrayBuffer().catch(() => {});

  // a project saved by two people: the second save with the old etag is refused
  const v1 = await admin.json("/api/files/raw/Trailer/Trailer.fcproj", { method: "PUT", raw: "v1", headers: { "If-None-Match": "*" } });
  assert.equal(v1.status, 200);
  await new Promise((r) => setTimeout(r, 15));
  const v2 = await admin.json("/api/files/raw/Trailer/Trailer.fcproj", { method: "PUT", raw: "v2", headers: { "If-Match": v1.data.etag } });
  assert.equal(v2.status, 200);
  const stale = await admin.json("/api/files/raw/Trailer/Trailer.fcproj", { method: "PUT", raw: "v2-other", headers: { "If-Match": v1.data.etag } });
  assert.equal(stale.status, 412);
  const exists = await admin.json("/api/files/raw/Trailer/Trailer.fcproj", { method: "PUT", raw: "x", headers: { "If-None-Match": "*" } });
  assert.equal(exists.status, 412);
  assert.equal(await (await admin.req("/api/files/raw/Trailer/Trailer.fcproj")).text(), "v2");

  assert.equal((await admin.json("/api/files/raw/..%2F..%2Fetc%2Fpasswd")).status, 400);
  assert.equal((await admin.json("/api/files/move", { method: "POST", body: { from: "Trailer", to: "Trailer/inside" } })).status, 400);
  assert.equal((await admin.json("/api/files/move", { method: "POST", body: { from: "Trailer/clip 01.mp4", to: "Media/clip.mp4" } })).status, 200);
  assert.equal((await admin.json("/api/files/raw/Media/clip.mp4", { method: "DELETE" })).status, 200);
  assert.equal(fs.readdirSync(path.join(dataDir, "trash")).length, 1);
  assert.equal((await admin.req("/api/files/raw/Media/clip.mp4")).status, 404);
  // no temp files left behind by the refused writes
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "files/Trailer")), ["Trailer.fcproj"]);
});

test("soft locks name who has a project open", async () => {
  const other = new Client("10.0.0.10");
  const inv = await admin.json("/api/invites", { method: "POST", body: {} });
  await other.register("invite", { token: new URL(inv.data.url).hash.slice(1), name: "Kasia" }, new SoftPasskey(ORIGIN, "localhost"));
  assert.deepEqual((await admin.json("/api/locks", { method: "POST", body: { path: "Trailer/Trailer.fcproj" } })).data, { ok: true });
  assert.deepEqual((await other.json("/api/locks", { method: "POST", body: { path: "Trailer/Trailer.fcproj" } })).data, { ok: false, holder: "Ryś" });
  const list = await other.json("/api/files?dir=Trailer");
  assert.equal(list.data.entries.find((e: any) => e.name === "Trailer.fcproj").lockedBy, "Ryś");
  await admin.json("/api/locks", { method: "DELETE", body: { path: "Trailer/Trailer.fcproj" } });
  assert.equal((await other.json("/api/locks", { method: "POST", body: { path: "Trailer/Trailer.fcproj" } })).data.ok, true);
});

test("sign-in attempts are rate limited per client", async () => {
  const c = new Client("10.9.9.9");
  let last = 0;
  for (let i = 0; i < 35; i++) last = (await c.json("/api/auth/status")).status;
  assert.equal(last, 429);
});

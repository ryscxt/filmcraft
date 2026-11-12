// FilmCraft host for Barley: passkey sign-in in front of the FilmCraft web build, and a shared
// files folder the editor reads (Range requests) and saves into.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, type Config } from "./config.ts";
import { Store } from "./db.ts";
import { Auth, accountRoutes } from "./auth.ts";
import { Files, filesRoutes } from "./files.ts";
import { HttpError, RateLimit, clientIp, json } from "./http.ts";
import { serveStatic } from "./static.ts";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  // wasm needs 'wasm-unsafe-eval'; FilmCraft decodes into blob: URLs and OffscreenCanvas
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Pages anyone may open (the sign-in screens). */
const PUBLIC_PAGES: Record<string, string> = { "/login": "login.html", "/setup": "login.html", "/invite": "login.html" };
/** Files from the FilmCraft build the editor page loads (the worklet is fetched relative to the page). */
const DIST_AT_ROOT = new Set(["audio-worklet.js", "favicon.png"]);

export function createServer(cfg: Config) {
  const store = new Store(cfg.dbPath);
  const auth = new Auth(cfg, store);
  const files = new Files(cfg.filesDir, cfg.trashDir, store);
  const authLimit = new RateLimit(30, 60_000);
  setInterval(() => store.sweep(), 60_000).unref();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (cfg.origin.startsWith("https://")) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    const url = new URL(req.url ?? "/", cfg.origin);
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/healthz") return json(res, 200, { ok: true });

    // Anything that changes state must come from our own pages (cookies are SameSite=Strict too).
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && req.headers.origin !== cfg.origin) {
      throw new HttpError(403, "cross-origin request refused");
    }

    if (p.startsWith("/api/auth/")) {
      if (!authLimit.allow(clientIp(req, cfg.trustProxy))) throw new HttpError(429, "too many attempts, wait a minute");
      if (await auth.route(req, res, url)) return;
      throw new HttpError(404, "not found");
    }
    if (PUBLIC_PAGES[p] && method === "GET") {
      if (await serveStatic(req, res, cfg.publicDir, PUBLIC_PAGES[p]!, url.searchParams)) return;
    }
    if (p.startsWith("/assets/")) {
      const name = p.slice("/assets/".length);
      if (name === "webauthn.js" && (await serveStatic(req, res, cfg.browserLibDir, "index.umd.min.js", url.searchParams))) return;
      // FilmCraft's own app icon from the web build (no copy of the asset in this folder)
      if (name === "icon.png" && (await serveStatic(req, res, cfg.distDir, "favicon.png", url.searchParams))) return;
      if (await serveStatic(req, res, cfg.publicDir, name, url.searchParams)) return;
      throw new HttpError(404, "not found");
    }

    const user = auth.user(req);
    if (!user) {
      if (p.startsWith("/api/")) throw new HttpError(401, "sign in first");
      res.writeHead(302, { Location: store.userCount() === 0 ? "/setup" : "/login" });
      return res.end();
    }

    if (p.startsWith("/api/")) {
      if (await accountRoutes(req, res, url, user, store, cfg)) return;
      if (await filesRoutes(req, res, url, user, files, store)) return;
      throw new HttpError(404, "not found");
    }
    if (p.startsWith("/fc/")) {
      if (await serveStatic(req, res, cfg.distDir, p.slice("/fc/".length), url.searchParams)) return;
      throw new HttpError(404, "not found");
    }
    if (DIST_AT_ROOT.has(p.slice(1)) && (await serveStatic(req, res, cfg.distDir, p.slice(1), url.searchParams))) return;
    if ((p === "/" || p === "/edit") && method === "GET") {
      if (await serveStatic(req, res, cfg.publicDir, p === "/" ? "files.html" : "edit.html", url.searchParams)) return;
    }
    throw new HttpError(404, "not found");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.destroy();
      const msg = e instanceof HttpError ? e.message : "internal error";
      // pages get a readable error, API calls JSON
      if ((req.url ?? "").startsWith("/api/")) json(res, status, { error: msg });
      else {
        res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(msg);
      }
    });
  });
  // long uploads and range reads of big media: no request timeout, but no idle sockets forever
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return { server, store };
}

if (import.meta.main) {
  const cfg = loadConfig();
  if (!cfg.setupToken) console.warn("SETUP_TOKEN is not set: the first admin cannot be created until it is");
  const { server } = createServer(cfg);
  server.listen(cfg.port, () => console.log(`filmcraft host on :${cfg.port} (origin ${cfg.origin}, rp ${cfg.rpId}, files ${cfg.filesDir})`));
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
}

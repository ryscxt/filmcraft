// Small helpers over node:http: JSON in/out, cookies, errors.
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(data);
}

const JSON_MAX = 1 << 20;

export async function readJson<T = any>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > JSON_MAX) throw new HttpError(413, "request too large");
    chunks.push(c as Buffer);
  }
  if (n === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const fwd = req.headers["x-forwarded-for"];
  if (trustProxy && typeof fwd === "string" && fwd) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "?";
}

/** Fixed-window rate limit per key. */
export class RateLimit {
  hits = new Map<string, { n: number; reset: number }>();
  limit: number;
  windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string): boolean {
    const t = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < t) {
      this.hits.set(key, { n: 1, reset: t + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < t) this.hits.delete(k);
      return true;
    }
    h.n += 1;
    return h.n <= this.limit;
  }
}

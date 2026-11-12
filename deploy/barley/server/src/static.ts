// Static files: the FilmCraft web build (wasm, glue, worklet) and this host's own pages.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * Serve `name` from `dir` (no subpaths outside it). Precompressed `.br` / `.gz` siblings are sent
 * when the browser accepts them. URLs with `?v=` carry a build hash and are cached forever;
 * everything else is revalidated.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string, name: string, query: URLSearchParams): Promise<boolean> {
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(name) || name.split("/").some((s) => s.startsWith("."))) return false;
  const abs = path.join(dir, name);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) return false;
  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isFile()) return false;
  const type = TYPES[path.extname(abs)] ?? "application/octet-stream";
  const accept = String(req.headers["accept-encoding"] ?? "");
  let file = abs;
  let encoding: string | undefined;
  for (const [enc, ext] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (accept.includes(enc) && fs.existsSync(abs + ext)) {
      file = abs + ext;
      encoding = enc;
      break;
    }
  }
  const size = (await fsp.stat(file)).size;
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Length": String(size),
    "Cache-Control": query.has("v") ? "public, max-age=31536000, immutable" : "no-cache",
    Vary: "Accept-Encoding",
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  await pipeline(fs.createReadStream(file), res);
  return true;
}

// The shared files API: list, read with Range, streamed atomic writes with If-Match, mkdir, move,
// delete to trash, soft edit locks. Every path goes through resolveIn (no escaping the folder).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json, readJson } from "./http.ts";
import { TEMP_PREFIX, cleanRel, resolveIn } from "./paths.ts";
import { token, type Store, type User } from "./db.ts";

export const LOCK_TTL_MS = 90_000;

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm",
  ".mxf": "application/mxf", ".avi": "video/x-msvideo", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".tif": "image/tiff",
  ".tiff": "image/tiff", ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json", ".fcproj": "application/octet-stream",
};

export const etagOf = (st: fs.Stats) => `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

export type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number; etag?: string; lockedBy?: string };

export class Files {
  root: string;
  trash: string;
  store: Store;

  constructor(root: string, trash: string, store: Store) {
    this.root = root;
    this.trash = trash;
    this.store = store;
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(trash, { recursive: true });
  }

  abs(rel: string) {
    return resolveIn(this.root, rel);
  }

  async list(rel: string, recursive = false): Promise<Entry[]> {
    const base = cleanRel(rel);
    const dir = this.abs(base);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw new HttpError(404, "no such folder");
    const locks = this.store.locks();
    const out: Entry[] = [];
    const walk = async (relDir: string, absDir: string, depth: number) => {
      for (const d of await fsp.readdir(absDir, { withFileTypes: true })) {
        if (d.name.startsWith(TEMP_PREFIX) || d.name === ".DS_Store") continue;
        if (!d.isFile() && !d.isDirectory()) continue; // no symlinks, sockets, …
        const p = relDir ? `${relDir}/${d.name}` : d.name;
        const s = await fsp.stat(path.join(absDir, d.name)).catch(() => null);
        if (!s) continue;
        const e: Entry = { name: d.name, path: p, dir: d.isDirectory(), size: s.isFile() ? s.size : 0, mtime: Math.floor(s.mtimeMs) };
        if (s.isFile()) e.etag = etagOf(s);
        const by = locks.get(p);
        if (by) e.lockedBy = by;
        out.push(e);
        if (recursive && d.isDirectory() && depth < 8 && out.length < 5000) await walk(p, path.join(absDir, d.name), depth + 1);
      }
    };
    await walk(base, dir, 0);
    out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
    return out;
  }

  /** GET/HEAD a file, honouring a single `Range: bytes=a-b` (what FilmCraft's mounted reads send). */
  async read(req: IncomingMessage, res: ServerResponse, rel: string, download: boolean) {
    const abs = this.abs(rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, "no such file");
    const etag = etagOf(st);
    const headers: Record<string, string> = {
      "Content-Type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": st.mtime.toUTCString(),
      "Cache-Control": "private, no-cache",
    };
    if (download) headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
    if (req.headers["if-none-match"] === etag && !req.headers.range) {
      res.writeHead(304, headers);
      return res.end();
    }
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === "" && m[2] === "")) throw new HttpError(416, "unsupported range");
      if (m[1] === "") {
        start = Math.max(0, st.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== "") end = Math.min(end, Number(m[2]));
      }
      if (start >= st.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
    }
    headers["Content-Length"] = String(st.size === 0 ? 0 : end - start + 1);
    res.writeHead(status, headers);
    if (req.method === "HEAD" || st.size === 0) return res.end();
    await pipeline(fs.createReadStream(abs, { start, end }), res);
  }

  /**
   * PUT: stream the body into a temp file next to the target, then rename over it. `If-Match`
   * (the etag the editor opened) refuses to overwrite someone else's newer save with 412;
   * `If-None-Match: *` refuses to replace an existing file.
   */
  async write(req: IncomingMessage, rel: string) {
    const clean = cleanRel(rel);
    if (!clean) throw new HttpError(400, "missing file name");
    const abs = this.abs(clean);
    const cur = await fsp.stat(abs).catch(() => null);
    if (cur?.isDirectory()) throw new HttpError(409, "a folder has that name");
    const ifMatch = req.headers["if-match"];
    if (ifMatch && (!cur || ifMatch !== etagOf(cur))) throw new HttpError(412, "the file changed on the server since you opened it");
    if (req.headers["if-none-match"] === "*" && cur) throw new HttpError(412, "the file already exists");
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    this.abs(clean); // re-check after creating parents (a symlink could have appeared)
    const tmp = path.join(path.dirname(abs), `${TEMP_PREFIX}${token(9)}`);
    try {
      await pipeline(req, fs.createWriteStream(tmp, { flags: "wx" }));
      // the check above and the rename are not atomic together; re-check right before replacing
      if (ifMatch) {
        const now = await fsp.stat(abs).catch(() => null);
        if (!now || etagOf(now) !== ifMatch) throw new HttpError(412, "the file changed on the server since you opened it");
      }
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const st = await fsp.stat(abs);
    return { path: clean, size: st.size, mtime: Math.floor(st.mtimeMs), etag: etagOf(st) };
  }

  async mkdir(rel: string) {
    const clean = cleanRel(rel);
    if (!clean) throw new HttpError(400, "missing folder name");
    await fsp.mkdir(this.abs(clean), { recursive: true });
    return { path: clean };
  }

  async move(from: string, to: string) {
    const a = cleanRel(from);
    const b = cleanRel(to);
    if (!a || !b) throw new HttpError(400, "missing path");
    if (b === a || b.startsWith(a + "/")) throw new HttpError(400, "cannot move a folder into itself");
    const absA = this.abs(a);
    const absB = this.abs(b);
    if (!(await fsp.stat(absA).catch(() => null))) throw new HttpError(404, "no such file");
    if (await fsp.stat(absB).catch(() => null)) throw new HttpError(409, "the target already exists");
    await fsp.mkdir(path.dirname(absB), { recursive: true });
    await fsp.rename(absA, absB);
    return { path: b };
  }

  /** Delete = move into the trash folder (outside the shared files), never unlink. */
  async remove(rel: string) {
    const clean = cleanRel(rel);
    if (!clean) throw new HttpError(400, "cannot delete the root folder");
    const abs = this.abs(clean);
    if (!(await fsp.stat(abs).catch(() => null))) throw new HttpError(404, "no such file");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await fsp.rename(abs, path.join(this.trash, `${stamp}_${clean.replaceAll("/", "__")}`));
    return { trashed: clean };
  }
}

const RAW = "/api/files/raw/";

/** Routes under /api/files and /api/locks for a signed-in user. Returns false when not matched. */
export async function filesRoutes(req: IncomingMessage, res: ServerResponse, url: URL, user: User, files: Files, store: Store): Promise<boolean> {
  const m = req.method ?? "GET";
  const p = url.pathname;
  if (p.startsWith(RAW)) {
    const rel = decodeURIComponent(p.slice(RAW.length));
    if (m === "GET" || m === "HEAD") {
      await files.read(req, res, rel, url.searchParams.has("download"));
      return true;
    }
    if (m === "PUT") return json(res, 200, await files.write(req, rel)), true;
    if (m === "DELETE") return json(res, 200, await files.remove(rel)), true;
    throw new HttpError(405, "method not allowed");
  }
  if (p === "/api/files" && m === "GET") {
    return json(res, 200, { entries: await files.list(url.searchParams.get("dir") ?? "", url.searchParams.get("recursive") === "1") }), true;
  }
  if (p === "/api/files/mkdir" && m === "POST") return json(res, 200, await files.mkdir(String((await readJson(req)).path ?? ""))), true;
  if (p === "/api/files/move" && m === "POST") {
    const b = await readJson(req);
    return json(res, 200, await files.move(String(b.from ?? ""), String(b.to ?? ""))), true;
  }
  if (p === "/api/locks" && (m === "POST" || m === "DELETE")) {
    const rel = cleanRel(String((await readJson(req)).path ?? ""));
    if (m === "DELETE") {
      store.unlock(rel, user.id);
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 200, store.lock(rel, user, LOCK_TTL_MS)), true;
  }
  return false;
}

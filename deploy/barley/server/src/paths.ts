// Mapping user-supplied relative paths onto the shared files folder, without escaping it.
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./http.ts";

export const PATH_MAX = 1024;
const SEGMENT_MAX = 255;
/** Names the server writes next to user files and never lists. */
export const TEMP_PREFIX = ".fc-upload-";

/**
 * Normalise a relative path ("Trailer/clip 01.mp4"): forward slashes, no empty, "." or ".."
 * segments, no NUL or backslash, no reserved temp names. Returns "" for the root.
 */
export function cleanRel(input: string): string {
  if (input.length > PATH_MAX) throw new HttpError(400, "path too long");
  if (/[\0\\]/.test(input)) throw new HttpError(400, "invalid path");
  const segs = input.split("/").filter((s) => s !== "");
  for (const s of segs) {
    if (s === "." || s === "..") throw new HttpError(400, "invalid path");
    if (s.length > SEGMENT_MAX) throw new HttpError(400, "name too long");
    if (s.startsWith(TEMP_PREFIX)) throw new HttpError(400, "reserved name");
  }
  return segs.join("/");
}

/**
 * The absolute path of `rel` under `root`, refusing anything that resolves outside it — also
 * through a symlink anywhere along the existing part of the path.
 */
export function resolveIn(root: string, rel: string): string {
  const clean = cleanRel(rel);
  const realRoot = fs.realpathSync(root);
  const abs = path.join(realRoot, clean);
  if (abs !== realRoot && !abs.startsWith(realRoot + path.sep)) throw new HttpError(400, "invalid path");
  // walk up to the deepest part that exists and check where it really is
  let probe = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(403, "path leaves the files folder");
      break;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  return abs;
}

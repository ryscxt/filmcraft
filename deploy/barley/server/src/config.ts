// Settings from the environment. Everything has a safe default except the passkey origin, which
// must match the URL people open (passkeys are bound to the RP ID, i.e. the domain).
import path from "node:path";

export type Config = {
  port: number;
  dataDir: string;
  filesDir: string;
  trashDir: string;
  dbPath: string;
  rpId: string;
  rpName: string;
  origin: string;
  setupToken: string;
  distDir: string;
  publicDir: string;
  browserLibDir: string;
  sessionDays: number;
  inviteHours: number;
  trustProxy: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const root = path.resolve(here, "..");
  const dataDir = path.resolve(env.DATA_DIR ?? "/data");
  const origin = (env.ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
  const rpId = env.RP_ID ?? new URL(origin).hostname;
  return {
    port: Number(env.PORT ?? 3000),
    dataDir,
    filesDir: path.join(dataDir, "files"),
    trashDir: path.join(dataDir, "trash"),
    dbPath: path.join(dataDir, "filmcraft.db"),
    rpId,
    rpName: env.RP_NAME ?? "FilmCraft",
    origin,
    setupToken: env.SETUP_TOKEN ?? "",
    distDir: path.resolve(env.DIST_DIR ?? path.join(root, "../../../target/web/dist")),
    publicDir: path.join(root, "public"),
    browserLibDir: path.join(root, "node_modules/@simplewebauthn/browser/dist/bundle"),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    inviteHours: Number(env.INVITE_HOURS ?? 24),
    trustProxy: (env.TRUST_PROXY ?? "1") !== "0",
  };
}

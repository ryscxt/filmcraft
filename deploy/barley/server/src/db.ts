// SQLite (node:sqlite, built into Node 24): users, passkeys, sessions, one-time challenges,
// invites and soft edit locks. Secrets (session and invite tokens) are stored only as SHA-256.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type User = { id: string; name: string; is_admin: number; created_at: number };
export type Credential = {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
};

export const now = () => Date.now();
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_used_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (
        hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT);
      CREATE TABLE IF NOT EXISTS locks (
        path TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }

  // users
  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }
  createUser(name: string, isAdmin: boolean, id = token(16)): User {
    const u: User = { id, name, is_admin: isAdmin ? 1 : 0, created_at: now() };
    this.db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, ?, ?)").run(u.id, u.name, u.is_admin, u.created_at);
    return u;
  }
  user(id: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
  }
  users(): (User & { passkeys: number; last_used_at: number | null })[] {
    return this.db
      .prepare(
        `SELECT u.*, COUNT(c.id) AS passkeys, MAX(c.last_used_at) AS last_used_at
         FROM users u LEFT JOIN credentials c ON c.user_id = u.id GROUP BY u.id ORDER BY u.created_at`,
      )
      .all() as (User & { passkeys: number; last_used_at: number | null })[];
  }
  deleteUser(id: string) {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }
  adminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").get() as { n: number }).n;
  }

  // passkeys
  addCredential(c: Omit<Credential, "created_at" | "last_used_at">) {
    this.db
      .prepare("INSERT INTO credentials (id, user_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.user_id, c.public_key, c.counter, c.transports, c.label, now());
  }
  credential(id: string): Credential | undefined {
    return this.db.prepare("SELECT * FROM credentials WHERE id = ?").get(id) as Credential | undefined;
  }
  credentialsOf(userId: string): Credential[] {
    return this.db.prepare("SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at").all(userId) as Credential[];
  }
  touchCredential(id: string, counter: number) {
    this.db.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, now(), id);
  }
  deleteCredential(userId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM credentials WHERE user_id = ? AND id = ?").run(userId, id).changes > 0;
  }

  // sessions: the cookie holds the token, the table its hash
  createSession(userId: string, days: number): string {
    const t = token();
    const at = now();
    this.db.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(t), userId, at, at + days * 86_400_000);
    return t;
  }
  sessionUser(t: string, days: number): User | undefined {
    const row = this.db
      .prepare("SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?")
      .get(sha256(t)) as (User & { expires_at: number }) | undefined;
    if (!row) return undefined;
    if (row.expires_at < now()) {
      this.deleteSession(t);
      return undefined;
    }
    // sliding expiry, refreshed at most once an hour
    const fresh = now() + days * 86_400_000;
    if (fresh - row.expires_at > 3_600_000) this.db.prepare("UPDATE sessions SET expires_at = ? WHERE hash = ?").run(fresh, sha256(t));
    const { expires_at: _e, ...u } = row;
    return u;
  }
  deleteSession(t: string) {
    this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(sha256(t));
  }
  deleteSessionsOf(userId: string) {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  // one-time WebAuthn challenges, 5 minutes
  putChallenge(challenge: string, kind: string, data: object): string {
    const id = token(16);
    this.db.prepare("INSERT INTO challenges (id, challenge, kind, data, expires_at) VALUES (?, ?, ?, ?, ?)").run(id, challenge, kind, JSON.stringify(data), now() + 300_000);
    return id;
  }
  takeChallenge(id: string, kind: string): { challenge: string; data: any } | undefined {
    const row = this.db.prepare("SELECT * FROM challenges WHERE id = ? AND kind = ?").get(id, kind) as
      | { challenge: string; data: string; expires_at: number }
      | undefined;
    this.db.prepare("DELETE FROM challenges WHERE id = ?").run(id);
    if (!row || row.expires_at < now()) return undefined;
    return { challenge: row.challenge, data: JSON.parse(row.data) };
  }

  // invites
  createInvite(createdBy: string, note: string, hours: number): { id: string; token: string; expires_at: number } {
    const t = token();
    const id = token(9);
    const expires_at = now() + hours * 3_600_000;
    this.db.prepare("INSERT INTO invites (hash, id, created_by, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(sha256(t), id, createdBy, note, now(), expires_at);
    return { id, token: t, expires_at };
  }
  /** A usable invite for this token (unused, not expired). */
  invite(t: string): { id: string; note: string } | undefined {
    const row = this.db.prepare("SELECT id, note, expires_at, used_at FROM invites WHERE hash = ?").get(sha256(t)) as
      | { id: string; note: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!row || row.used_at || row.expires_at < now()) return undefined;
    return { id: row.id, note: row.note };
  }
  /** Mark the invite used; false when someone else used it first. */
  useInvite(t: string, userId: string): boolean {
    return this.db.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL AND expires_at >= ?").run(now(), userId, sha256(t), now()).changes > 0;
  }
  invites() {
    return this.db.prepare("SELECT id, note, created_at, expires_at, used_at, used_by FROM invites ORDER BY created_at DESC LIMIT 50").all();
  }
  deleteInvite(id: string) {
    this.db.prepare("DELETE FROM invites WHERE id = ?").run(id);
  }

  // soft edit locks: who has a project open, refreshed by a heartbeat
  lock(p: string, user: User, ttlMs: number): { ok: boolean; holder?: string } {
    const row = this.db.prepare("SELECT * FROM locks WHERE path = ?").get(p) as { user_id: string; user_name: string; expires_at: number } | undefined;
    if (row && row.user_id !== user.id && row.expires_at > now()) return { ok: false, holder: row.user_name };
    this.db.prepare("INSERT OR REPLACE INTO locks (path, user_id, user_name, expires_at) VALUES (?, ?, ?, ?)").run(p, user.id, user.name, now() + ttlMs);
    return { ok: true };
  }
  unlock(p: string, userId: string) {
    this.db.prepare("DELETE FROM locks WHERE path = ? AND user_id = ?").run(p, userId);
  }
  locks(): Map<string, string> {
    const rows = this.db.prepare("SELECT path, user_name FROM locks WHERE expires_at > ?").all(now()) as { path: string; user_name: string }[];
    return new Map(rows.map((r) => [r.path, r.user_name]));
  }

  sweep() {
    const t = now();
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(t);
    this.db.prepare("DELETE FROM challenges WHERE expires_at < ?").run(t);
    this.db.prepare("DELETE FROM locks WHERE expires_at < ?").run(t);
  }
}

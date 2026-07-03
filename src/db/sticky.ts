import { db } from "./client";

const selectByKey = db.query<{ account_id: string; updated_at: number }, [string]>(
  "SELECT account_id, updated_at FROM sticky_sessions WHERE key = ?",
);
const upsert = db.prepare(
  `INSERT INTO sticky_sessions (key, account_id, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at`,
);

export function getSticky(key: string, ttlMs: number, now: number): string | null {
  const row = selectByKey.get(key);
  if (!row) return null;
  if (now - row.updated_at > ttlMs) {
    db.prepare("DELETE FROM sticky_sessions WHERE key = ?").run(key);
    return null;
  }
  return row.account_id;
}

export function setSticky(key: string, accountId: string, now: number): void {
  upsert.run(key, accountId, now);
}

/** Refresh TTL without changing the pinned account. */
export function touchSticky(key: string, now: number): void {
  db.prepare("UPDATE sticky_sessions SET updated_at = ? WHERE key = ?").run(now, key);
}

export function cleanupSticky(ttlMs: number, now: number): void {
  db.prepare("DELETE FROM sticky_sessions WHERE updated_at < ?").run(now - ttlMs);
}

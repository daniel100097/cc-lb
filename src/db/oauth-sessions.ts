import { db } from "./client";

export interface OAuthSession {
  id: string;
  verifier: string;
  state: string;
  account_id: string | null;
  name: string | null;
  priority: number;
  created_at: number;
  expires_at: number;
}

export interface NewOAuthSession {
  id: string;
  verifier: string;
  state: string;
  accountId?: string | null;
  name?: string | null;
  priority?: number;
  createdAt: number;
  expiresAt: number;
}

const insert = db.prepare(
  `INSERT INTO oauth_sessions
     (id, verifier, state, account_id, name, priority, created_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);

const selectById = db.query<OAuthSession, [string]>(
  "SELECT id, verifier, state, account_id, name, priority, created_at, expires_at FROM oauth_sessions WHERE id = ?",
);

export function createOAuthSession(session: NewOAuthSession): void {
  cleanupExpiredOAuthSessions(Date.now());
  insert.run(
    session.id,
    session.verifier,
    session.state,
    session.accountId ?? null,
    session.name ?? null,
    session.priority ?? 0,
    session.createdAt,
    session.expiresAt,
  );
}

export function getOAuthSession(id: string, now = Date.now()): OAuthSession | null {
  const session = selectById.get(id);
  if (!session) return null;
  if (session.expires_at <= now) {
    deleteOAuthSession(id);
    return null;
  }
  return session;
}

export function deleteOAuthSession(id: string): void {
  db.prepare("DELETE FROM oauth_sessions WHERE id = ?").run(id);
}

export function cleanupExpiredOAuthSessions(now: number): void {
  db.prepare("DELETE FROM oauth_sessions WHERE expires_at <= ?").run(now);
}

import { eq, lte } from "drizzle-orm";
import { orm } from "./client";
import { oauthSessions } from "./schema";

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

type OAuthSessionRow = typeof oauthSessions.$inferSelect;

export function createOAuthSession(session: NewOAuthSession): void {
  cleanupExpiredOAuthSessions(Date.now());
  orm
    .insert(oauthSessions)
    .values({
      id: session.id,
      verifier: session.verifier,
      state: session.state,
      accountId: session.accountId ?? null,
      name: session.name ?? null,
      priority: session.priority ?? 0,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    })
    .run();
}

export function getOAuthSession(id: string, now = Date.now()): OAuthSession | null {
  const session = orm.select().from(oauthSessions).where(eq(oauthSessions.id, id)).get();
  if (!session) return null;
  if (session.expiresAt <= now) {
    deleteOAuthSession(id);
    return null;
  }
  return toOAuthSession(session);
}

export function deleteOAuthSession(id: string): void {
  orm.delete(oauthSessions).where(eq(oauthSessions.id, id)).run();
}

export function cleanupExpiredOAuthSessions(now: number): void {
  orm.delete(oauthSessions).where(lte(oauthSessions.expiresAt, now)).run();
}

function toOAuthSession(row: OAuthSessionRow): OAuthSession {
  return {
    id: row.id,
    verifier: row.verifier,
    state: row.state,
    account_id: row.accountId,
    name: row.name,
    priority: row.priority,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
  };
}

import { eq, lt } from "drizzle-orm";
import { orm } from "./client";
import { stickySessions } from "./schema";

export function getSticky(key: string, ttlMs: number, now: number): string | null {
  const row = orm
    .select({
      accountId: stickySessions.accountId,
      updatedAt: stickySessions.updatedAt,
    })
    .from(stickySessions)
    .where(eq(stickySessions.key, key))
    .get();
  if (!row) return null;
  if (now - row.updatedAt > ttlMs) {
    orm.delete(stickySessions).where(eq(stickySessions.key, key)).run();
    return null;
  }
  return row.accountId;
}

export function setSticky(key: string, accountId: string, now: number): void {
  orm
    .insert(stickySessions)
    .values({ key, accountId, updatedAt: now })
    .onConflictDoUpdate({
      target: stickySessions.key,
      set: { accountId, updatedAt: now },
    })
    .run();
}

/** Refresh TTL without changing the pinned account. */
export function touchSticky(key: string, now: number): void {
  orm.update(stickySessions).set({ updatedAt: now }).where(eq(stickySessions.key, key)).run();
}

export function cleanupSticky(ttlMs: number, now: number): void {
  orm.delete(stickySessions).where(lt(stickySessions.updatedAt, now - ttlMs)).run();
}

import { eq, lt } from "drizzle-orm";
import { db } from "./client";
import { orm } from "./client";
import { stickySessions } from "./schema";

export type StickySortBy = "key" | "updated_at" | "account_name";
export type StickySortDirection = "asc" | "desc";

export interface StickySessionFilter {
  limit: number;
  offset: number;
  ttlMs: number;
  now: number;
  accountId?: string | null;
  accountQuery?: string | null;
  search?: string | null;
  stale?: boolean | null;
  sortBy?: StickySortBy;
  sortDirection?: StickySortDirection;
}

export interface StickySessionEntry {
  key: string;
  kind: "prompt_cache";
  account_id: string;
  account_name: string | null;
  updated_at: number;
  expires_at: number;
  age_ms: number;
  stale: boolean;
}

export interface StickySessionPage {
  entries: StickySessionEntry[];
  total: number;
  stalePromptCacheCount: number;
}

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

export function listStickySessions(filter: StickySessionFilter): StickySessionPage {
  const where = buildStickyWhere(filter);
  const total = countStickyWhere(where);
  const stalePromptCacheCount = countStickyWhere(buildStickyWhere({ ...filter, stale: true }));
  const rows = queryStickyRows<StickySessionRow>(
    `
      SELECT
        sticky_sessions.key AS key,
        sticky_sessions.account_id AS accountId,
        accounts.name AS accountName,
        sticky_sessions.updated_at AS updatedAt
      FROM sticky_sessions
      LEFT JOIN accounts ON accounts.id = sticky_sessions.account_id
      WHERE ${where.clause}
      ORDER BY ${sortColumn(filter.sortBy)} ${sortDirection(filter.sortDirection)}, sticky_sessions.key ASC
      LIMIT ? OFFSET ?
    `,
    [...where.params, filter.limit, filter.offset],
  );

  return {
    entries: rows.map((row) => toStickySessionEntry(row, filter.ttlMs, filter.now)),
    total,
    stalePromptCacheCount,
  };
}

export function deleteStickySessions(keys: string[]): number {
  const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
  if (uniqueKeys.length === 0) return 0;

  const stmt = db.prepare("DELETE FROM sticky_sessions WHERE key = ?");
  let deleted = 0;
  const tx = db.transaction((values: string[]) => {
    for (const key of values) {
      deleted += Number(stmt.run(key).changes ?? 0);
    }
  });
  tx(uniqueKeys);
  return deleted;
}

export function deleteFilteredStickySessions(filter: StickySessionFilter): number {
  const where = buildStickyWhere(filter);
  const result = db
    .query(
      `
        DELETE FROM sticky_sessions
        WHERE key IN (
          SELECT sticky_sessions.key
          FROM sticky_sessions
          LEFT JOIN accounts ON accounts.id = sticky_sessions.account_id
          WHERE ${where.clause}
        )
      `,
    )
    .run(...where.params);
  return Number(result.changes ?? 0);
}

export function purgeStaleStickySessions(ttlMs: number, now: number): number {
  const result = db.query("DELETE FROM sticky_sessions WHERE updated_at < ?").run(now - ttlMs);
  return Number(result.changes ?? 0);
}

function toStickySessionEntry(row: StickySessionRow, ttlMs: number, now: number): StickySessionEntry {
  const ageMs = Math.max(0, now - row.updatedAt);
  return {
    key: row.key,
    kind: "prompt_cache",
    account_id: row.accountId,
    account_name: row.accountName,
    updated_at: row.updatedAt,
    expires_at: row.updatedAt + ttlMs,
    age_ms: ageMs,
    stale: ageMs > ttlMs,
  };
}

function buildStickyWhere(filter: StickySessionFilter): StickyWhere {
  const conditions: string[] = ["1 = 1"];
  const params: Array<string | number> = [];

  if (filter.accountId) {
    conditions.push("sticky_sessions.account_id = ?");
    params.push(filter.accountId);
  }

  if (filter.accountQuery?.trim()) {
    conditions.push("(sticky_sessions.account_id LIKE ? OR accounts.name LIKE ?)");
    const term = `%${filter.accountQuery.trim()}%`;
    params.push(term, term);
  }

  if (filter.search?.trim()) {
    conditions.push("sticky_sessions.key LIKE ?");
    const term = `%${filter.search.trim()}%`;
    params.push(term);
  }

  if (filter.stale === true) {
    conditions.push("sticky_sessions.updated_at < ?");
    params.push(filter.now - filter.ttlMs);
  } else if (filter.stale === false) {
    conditions.push("sticky_sessions.updated_at >= ?");
    params.push(filter.now - filter.ttlMs);
  }

  return { clause: conditions.join(" AND "), params };
}

function countStickyWhere(where: StickyWhere): number {
  const row = db
    .query<CountRow, Array<string | number>>(
      `
        SELECT COUNT(*) AS count
        FROM sticky_sessions
        LEFT JOIN accounts ON accounts.id = sticky_sessions.account_id
        WHERE ${where.clause}
      `,
    )
    .get(...where.params);
  return Number(row?.count ?? 0);
}

function queryStickyRows<T>(sql: string, params: Array<string | number>): T[] {
  return db.query<T, Array<string | number>>(sql).all(...params);
}

function sortColumn(sortBy: StickySortBy | undefined): string {
  if (sortBy === "key") return "sticky_sessions.key";
  if (sortBy === "account_name") return "accounts.name";
  return "sticky_sessions.updated_at";
}

function sortDirection(direction: StickySortDirection | undefined): "ASC" | "DESC" {
  return direction === "asc" ? "ASC" : "DESC";
}

interface StickyWhere {
  clause: string;
  params: Array<string | number>;
}

interface StickySessionRow {
  key: string;
  accountId: string;
  accountName: string | null;
  updatedAt: number;
}

interface CountRow {
  count: number;
}

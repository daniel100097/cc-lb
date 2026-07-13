import { eq } from "drizzle-orm";
import { db, orm } from "./client";
import { stickySessions } from "./schema";

export type StickySortBy = "key" | "updated_at" | "account_name";
export type StickySortDirection = "asc" | "desc";
export type StickySessionStatus = "pending" | "active" | "blocked";

export interface StickyBinding {
  accountId: string;
  status: StickySessionStatus;
}

export interface StickyIdentityBinding extends StickyBinding {
  clientDeviceId: string | null;
}

export interface StickySessionFilter {
  limit: number;
  offset: number;
  now: number;
  accountId?: string | null;
  accountQuery?: string | null;
  search?: string | null;
  sortBy?: StickySortBy;
  sortDirection?: StickySortDirection;
}

export interface StickySessionEntry {
  key: string;
  account_id: string;
  account_name: string | null;
  updated_at: number;
  age_ms: number;
  status: StickySessionStatus;
}

export interface StickySessionPage {
  entries: StickySessionEntry[];
  total: number;
  activeCount: number;
  pendingCount: number;
}

export function getSticky(key: string): StickyBinding | null {
  const row = getStickyIdentity(key);
  return row ? { accountId: row.accountId, status: row.status } : null;
}

/** Read the durable account, admission state, and original client device identity. */
export function getStickyIdentity(key: string): StickyIdentityBinding | null {
  const row = orm
    .select({
      accountId: stickySessions.accountId,
      status: stickySessions.status,
      clientDeviceId: stickySessions.clientDeviceId,
    })
    .from(stickySessions)
    .where(eq(stickySessions.key, key))
    .get();
  return row
    ? {
        accountId: row.accountId,
        status: stickyStatus(row.status),
        clientDeviceId: row.clientDeviceId,
      }
    : null;
}

/**
 * Atomically claim a chat. Every existing row, including pending and blocked
 * bindings, wins. A concurrently deleted account produces a blocked tombstone,
 * never an orphan that could later be reassigned.
 */
export function claimSticky(
  key: string,
  accountId: string,
  now: number,
  clientDeviceId: string | null = null,
): StickyBinding {
  const claimed = claimStickyWithStatus(key, accountId, now, "active", clientDeviceId);
  return { accountId: claimed.accountId, status: claimed.status };
}

/**
 * Permanently pin an unadmitted chat to its first account. Pending bindings do
 * not expire and cannot be reassigned; an existing row always wins.
 */
export function claimPendingSticky(
  key: string,
  accountId: string,
  now: number,
  clientDeviceId: string | null = null,
): StickyIdentityBinding {
  return claimStickyWithStatus(key, accountId, now, "pending", clientDeviceId);
}

function claimStickyWithStatus(
  key: string,
  accountId: string,
  now: number,
  status: "active" | "pending",
  clientDeviceId: string | null,
): StickyIdentityBinding {
  db.query(
    `
      INSERT INTO sticky_sessions (key, account_id, updated_at, status, client_device_id)
      VALUES (
        ?,
        ?,
        ?,
        CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE id = ?) THEN ? ELSE 'blocked' END,
        ?
      )
      ON CONFLICT(key) DO NOTHING
    `,
  ).run(key, accountId, now, accountId, status, clientDeviceId);

  const claimed = getStickyIdentity(key);
  if (!claimed) throw new Error("sticky claim failed");
  return claimed;
}

/**
 * Bind the original client device identity exactly once. The returned value is
 * the winning durable identity, so callers can reject a conflicting value.
 */
export function bindStickyClientDeviceId(key: string, clientDeviceId: string): StickyIdentityBinding | null {
  if (clientDeviceId.length === 0) throw new Error("client device ID must not be empty");
  db.query(
    `
      UPDATE sticky_sessions
      SET client_device_id = ?
      WHERE key = ?
        AND client_device_id IS NULL
        AND status IN ('active', 'pending')
    `,
  ).run(clientDeviceId, key);
  return getStickyIdentity(key);
}

/** Atomically admit a pending chat without changing its pinned account. */
export function promotePendingSticky(key: string, now: number): StickyIdentityBinding | null {
  db.query(
    `
      UPDATE sticky_sessions
      SET
        status = CASE
          WHEN EXISTS (
            SELECT 1 FROM accounts WHERE accounts.id = sticky_sessions.account_id
          ) THEN 'active'
          ELSE 'blocked'
        END,
        updated_at = ?
      WHERE key = ? AND status = 'pending'
    `,
  ).run(now, key);
  return getStickyIdentity(key);
}

/** Record activity without changing the pinned account. */
export function touchSticky(key: string, now: number): void {
  db.query(
    "UPDATE sticky_sessions SET updated_at = ? WHERE key = ? AND status IN ('active', 'pending')",
  ).run(now, key);
}

export function listStickySessions(filter: StickySessionFilter): StickySessionPage {
  const where = buildStickyWhere(filter);
  const total = countStickyWhere(where);
  const activeCount = countStickyWhere({
    clause: `(${where.clause}) AND sticky_sessions.status = 'active'`,
    params: where.params,
  });
  const pendingCount = countStickyWhere({
    clause: `(${where.clause}) AND sticky_sessions.status = 'pending'`,
    params: where.params,
  });
  const rows = queryStickyRows<StickySessionRow>(
    `
      SELECT
        sticky_sessions.key AS key,
        sticky_sessions.account_id AS accountId,
        accounts.name AS accountName,
        sticky_sessions.updated_at AS updatedAt,
        sticky_sessions.status AS status
      FROM sticky_sessions
      LEFT JOIN accounts ON accounts.id = sticky_sessions.account_id
      WHERE ${where.clause}
      ORDER BY ${sortColumn(filter.sortBy)} ${sortDirection(filter.sortDirection)}, sticky_sessions.key ASC
      LIMIT ? OFFSET ?
    `,
    [...where.params, filter.limit, filter.offset],
  );

  return {
    entries: rows.map((row) => toStickySessionEntry(row, filter.now)),
    total,
    activeCount,
    pendingCount,
  };
}

export function blockStickySessions(keys: string[], now: number): number {
  const uniqueKeys = Array.from(new Set(keys.filter((key) => key.length > 0)));
  if (uniqueKeys.length === 0) return 0;

  const stmt = db.prepare(
    "UPDATE sticky_sessions SET status = 'blocked', updated_at = ? WHERE key = ? AND status <> 'blocked'",
  );
  let blocked = 0;
  const tx = db.transaction((values: string[]) => {
    for (const key of values) {
      blocked += Number(stmt.run(now, key).changes ?? 0);
    }
  });
  tx(uniqueKeys);
  return blocked;
}

export function blockFilteredStickySessions(filter: StickySessionFilter): number {
  const where = buildStickyWhere(filter);
  const result = db
    .query(
      `
        UPDATE sticky_sessions
        SET status = 'blocked', updated_at = ?
        WHERE status <> 'blocked' AND key IN (
          SELECT sticky_sessions.key
          FROM sticky_sessions
          LEFT JOIN accounts ON accounts.id = sticky_sessions.account_id
          WHERE ${where.clause}
        )
      `,
    )
    .run(filter.now, ...where.params);
  return Number(result.changes ?? 0);
}

function toStickySessionEntry(row: StickySessionRow, now: number): StickySessionEntry {
  return {
    key: row.key,
    account_id: row.accountId,
    account_name: row.accountName,
    updated_at: row.updatedAt,
    age_ms: Math.max(0, now - row.updatedAt),
    status: stickyStatus(row.status),
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
    params.push(`%${filter.search.trim()}%`);
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
  status: string;
}

interface CountRow {
  count: number;
}

function stickyStatus(value: string): StickySessionStatus {
  if (value === "pending") return "pending";
  return value === "active" ? "active" : "blocked";
}

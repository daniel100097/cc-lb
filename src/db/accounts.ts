import { randomUUID } from "node:crypto";
import { db } from "./client";

export interface Account {
  id: string;
  name: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  refresh_token_issued_at: number | null;
  scopes: string | null;
  created_at: number;
  last_used: number | null;
  priority: number;
  request_count: number;
  session_start: number | null;
  session_request_count: number;
  rate_limit_status: string | null;
  rate_limit_reset: number | null;
  rate_limit_remaining: number | null;
  rate_limited_until: number | null;
  consecutive_rate_limits: number;
  needs_reauth: number;
  paused: number;
  pause_reason: string | null;
}

export interface NewAccount {
  name: string;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  refresh_token_issued_at?: number | null;
  scopes?: string | null;
  priority?: number;
}

type AccountValue = string | number | null;
export type AccountPatch = Partial<Omit<Account, "id">>;

const selectAll = db.query<Account, []>("SELECT * FROM accounts ORDER BY priority ASC, created_at ASC");
const selectById = db.query<Account, [string]>("SELECT * FROM accounts WHERE id = ?");

export function listAccounts(): Account[] {
  return selectAll.all();
}

export function getAccount(id: string): Account | null {
  return selectById.get(id) ?? null;
}

export function createAccount(a: NewAccount): Account {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts
       (id, name, access_token, refresh_token, expires_at, refresh_token_issued_at,
        scopes, created_at, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    a.name,
    a.access_token ?? null,
    a.refresh_token ?? null,
    a.expires_at ?? null,
    a.refresh_token_issued_at ?? null,
    a.scopes ?? null,
    now,
    a.priority ?? 0,
  );
  const account = getAccount(id);
  if (!account) throw new Error("account insert failed");
  return account;
}

export function updateAccount(id: string, patch: AccountPatch): void {
  const set: string[] = [];
  const values: AccountValue[] = [];
  const add = (column: string, value: AccountValue | undefined) => {
    if (value === undefined) return;
    set.push(`${column} = ?`);
    values.push(value);
  };

  add("name", patch.name);
  add("access_token", patch.access_token);
  add("refresh_token", patch.refresh_token);
  add("expires_at", patch.expires_at);
  add("refresh_token_issued_at", patch.refresh_token_issued_at);
  add("scopes", patch.scopes);
  add("created_at", patch.created_at);
  add("last_used", patch.last_used);
  add("priority", patch.priority);
  add("request_count", patch.request_count);
  add("session_start", patch.session_start);
  add("session_request_count", patch.session_request_count);
  add("rate_limit_status", patch.rate_limit_status);
  add("rate_limit_reset", patch.rate_limit_reset);
  add("rate_limit_remaining", patch.rate_limit_remaining);
  add("rate_limited_until", patch.rate_limited_until);
  add("consecutive_rate_limits", patch.consecutive_rate_limits);
  add("needs_reauth", patch.needs_reauth);
  add("paused", patch.paused);
  add("pause_reason", patch.pause_reason);

  if (set.length === 0) return;
  db.prepare(`UPDATE accounts SET ${set.join(", ")} WHERE id = ?`).run(...values, id);
}

export function deleteAccount(id: string): void {
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

export function bumpRequestCount(id: string, now: number): void {
  db.prepare(
    `UPDATE accounts
       SET request_count = request_count + 1,
           session_request_count = session_request_count + 1,
           last_used = ?
     WHERE id = ?`,
  ).run(now, id);
}

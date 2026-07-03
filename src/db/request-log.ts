import { db } from "./client";

export interface RequestLogInput {
  accountId: string | null;
  ts: number;
  status: number | null;
  model?: string | null;
  outcome: string;
}

export interface RecentRequestLog {
  id: number;
  account_id: string | null;
  ts: number;
  status: number | null;
  model: string | null;
  outcome: string | null;
}

export interface OutcomeCount {
  outcome: string;
  count: number;
}

const insert = db.prepare(
  "INSERT INTO request_log (account_id, ts, status, model, outcome) VALUES (?, ?, ?, ?, ?)",
);

export function logRequest(input: RequestLogInput): void {
  insert.run(input.accountId, input.ts, input.status, input.model ?? null, input.outcome);
  pruneRequestLog(input.ts);
}

export function countRequestsSince(ts: number): number {
  const row = db.query<{ count: number }, [number]>("SELECT COUNT(*) AS count FROM request_log WHERE ts >= ?").get(ts);
  return row?.count ?? 0;
}

export function listRecentRequests(limit: number): RecentRequestLog[] {
  return db
    .query<RecentRequestLog, [number]>(
      "SELECT id, account_id, ts, status, model, outcome FROM request_log ORDER BY ts DESC LIMIT ?",
    )
    .all(limit);
}

export function countOutcomesSince(ts: number): OutcomeCount[] {
  return db
    .query<OutcomeCount, [number]>(
      "SELECT COALESCE(outcome, 'unknown') AS outcome, COUNT(*) AS count FROM request_log WHERE ts >= ? GROUP BY outcome ORDER BY count DESC",
    )
    .all(ts);
}

function pruneRequestLog(now: number): void {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM request_log WHERE ts < ?").run(now - thirtyDaysMs);
}

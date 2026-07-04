import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, isNotNull, like, lt, lte, ne, or } from "drizzle-orm";
import { accounts, apiKeys, requestLog } from "./schema";
import { orm } from "./client";

export interface RequestLogInput {
  accountId: string | null;
  apiKeyId?: string | null;
  ts: number;
  status: number | null;
  model?: string | null;
  outcome: string;
  method?: string | null;
  path?: string | null;
  failoverAttempt?: number;
  latencyMs?: number | null;
  totalMs?: number | null;
  error?: string | null;
  upstreamRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  rawRequestHeaders?: string | null;
  rawRequestBody?: string | null;
  rawResponseHeaders?: string | null;
  rawResponseBody?: string | null;
}

export interface RequestLogUsagePatch {
  status?: number | null;
  outcome?: string | null;
  totalMs?: number | null;
  upstreamRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  error?: string | null;
  rawResponseHeaders?: string | null;
  rawResponseBody?: string | null;
}

export interface RecentRequestLog {
  id: number;
  account_id: string | null;
  api_key_id: string | null;
  ts: number;
  status: number | null;
  model: string | null;
  outcome: string | null;
}

export interface OutcomeCount {
  outcome: string;
  count: number;
}

export interface RequestLogEntry {
  id: number;
  account_id: string | null;
  account_name: string | null;
  api_key_id: string | null;
  api_key_name: string | null;
  ts: number;
  status: number | null;
  model: string | null;
  outcome: string | null;
  method: string | null;
  path: string | null;
  failover_attempt: number;
  latency_ms: number | null;
  total_ms: number | null;
  error: string | null;
  upstream_request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  raw_request_headers: string | null;
  raw_request_body: string | null;
  raw_response_headers: string | null;
  raw_response_body: string | null;
}

export interface RequestLogFilter {
  limit: number;
  offset: number;
  accountId?: string | null;
  apiKeyId?: string | null;
  outcome?: string | null;
  model?: string | null;
  since?: number | null;
  until?: number | null;
  search?: string | null;
}

export interface RequestLogPage {
  entries: RequestLogEntry[];
  total: number;
}

export function logRequest(input: RequestLogInput): number {
  const inserted = orm
    .insert(requestLog)
    .values({
      accountId: input.accountId,
      apiKeyId: input.apiKeyId ?? null,
      ts: input.ts,
      status: input.status,
      model: input.model ?? null,
      outcome: input.outcome,
      method: input.method ?? null,
      path: input.path ?? null,
      failoverAttempt: input.failoverAttempt ?? 0,
      latencyMs: input.latencyMs ?? null,
      totalMs: input.totalMs ?? null,
      error: input.error ?? null,
      upstreamRequestId: input.upstreamRequestId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheCreationTokens: input.cacheCreationTokens ?? null,
      costUsd: input.costUsd ?? null,
      rawRequestHeaders: input.rawRequestHeaders ?? null,
      rawRequestBody: input.rawRequestBody ?? null,
      rawResponseHeaders: input.rawResponseHeaders ?? null,
      rawResponseBody: input.rawResponseBody ?? null,
    })
    .returning({ id: requestLog.id })
    .get();

  if (!inserted) throw new Error("request log insert failed");
  pruneRequestLog(input.ts);
  return inserted.id;
}

export function updateRequestLogUsage(id: number, patch: RequestLogUsagePatch): void {
  const values: RequestLogUpdateValues = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.outcome !== undefined) values.outcome = patch.outcome;
  if (patch.totalMs !== undefined) values.totalMs = patch.totalMs;
  if (patch.upstreamRequestId !== undefined) values.upstreamRequestId = patch.upstreamRequestId;
  if (patch.inputTokens !== undefined) values.inputTokens = patch.inputTokens;
  if (patch.outputTokens !== undefined) values.outputTokens = patch.outputTokens;
  if (patch.cacheReadTokens !== undefined) values.cacheReadTokens = patch.cacheReadTokens;
  if (patch.cacheCreationTokens !== undefined) values.cacheCreationTokens = patch.cacheCreationTokens;
  if (patch.costUsd !== undefined) values.costUsd = patch.costUsd;
  if (patch.error !== undefined) values.error = patch.error;
  if (patch.rawResponseHeaders !== undefined) values.rawResponseHeaders = patch.rawResponseHeaders;
  if (patch.rawResponseBody !== undefined) values.rawResponseBody = patch.rawResponseBody;
  if (Object.keys(values).length === 0) return;

  orm.update(requestLog).set(values).where(eq(requestLog.id, id)).run();
}

export function countRequestsSince(ts: number): number {
  const row = orm.select({ count: count() }).from(requestLog).where(gte(requestLog.ts, ts)).get();
  return row?.count ?? 0;
}

export function listRecentRequests(limit: number): RecentRequestLog[] {
  return orm
    .select({
      id: requestLog.id,
      account_id: requestLog.accountId,
      api_key_id: requestLog.apiKeyId,
      ts: requestLog.ts,
      status: requestLog.status,
      model: requestLog.model,
      outcome: requestLog.outcome,
    })
    .from(requestLog)
    .orderBy(desc(requestLog.ts))
    .limit(limit)
    .all();
}

export function countOutcomesSince(ts: number): OutcomeCount[] {
  return orm
    .select({
      outcome: requestLog.outcome,
      count: count(),
    })
    .from(requestLog)
    .where(gte(requestLog.ts, ts))
    .groupBy(requestLog.outcome)
    .orderBy(desc(count()))
    .all()
    .map((row) => ({ outcome: row.outcome ?? "unknown", count: row.count }));
}

export function listRequests(filter: RequestLogFilter): RequestLogPage {
  const where = buildWhere(filter);
  const totalRow = where
    ? orm.select({ count: count() }).from(requestLog).where(where).get()
    : orm.select({ count: count() }).from(requestLog).get();

  const selectFields = requestSelectFields();
  const rows = where
    ? orm
        .select(selectFields)
        .from(requestLog)
        .leftJoin(accounts, eq(accounts.id, requestLog.accountId))
        .leftJoin(apiKeys, eq(apiKeys.id, requestLog.apiKeyId))
        .where(where)
        .orderBy(desc(requestLog.ts), desc(requestLog.id))
        .limit(filter.limit)
        .offset(filter.offset)
        .all()
    : orm
        .select(selectFields)
        .from(requestLog)
        .leftJoin(accounts, eq(accounts.id, requestLog.accountId))
        .leftJoin(apiKeys, eq(apiKeys.id, requestLog.apiKeyId))
        .orderBy(desc(requestLog.ts), desc(requestLog.id))
        .limit(filter.limit)
        .offset(filter.offset)
        .all();

  return {
    entries: rows.map(toRequestLogEntry),
    total: totalRow?.count ?? 0,
  };
}

export function listRequestModels(): string[] {
  return orm
    .select({ model: requestLog.model })
    .from(requestLog)
    .where(and(isNotNull(requestLog.model), ne(requestLog.model, "")))
    .groupBy(requestLog.model)
    .orderBy(requestLog.model)
    .all()
    .flatMap((row) => (row.model ? [row.model] : []));
}

export function listRequestOutcomes(): string[] {
  return orm
    .select({ outcome: requestLog.outcome })
    .from(requestLog)
    .where(and(isNotNull(requestLog.outcome), ne(requestLog.outcome, "")))
    .groupBy(requestLog.outcome)
    .orderBy(requestLog.outcome)
    .all()
    .flatMap((row) => (row.outcome ? [row.outcome] : []));
}

interface RequestLogUpdateValues {
  status?: number | null;
  outcome?: string | null;
  totalMs?: number | null;
  upstreamRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  error?: string | null;
  rawResponseHeaders?: string | null;
  rawResponseBody?: string | null;
}

function requestSelectFields() {
  return {
    id: requestLog.id,
    accountId: requestLog.accountId,
    accountName: accounts.name,
    apiKeyId: requestLog.apiKeyId,
    apiKeyName: apiKeys.name,
    ts: requestLog.ts,
    status: requestLog.status,
    model: requestLog.model,
    outcome: requestLog.outcome,
    method: requestLog.method,
    path: requestLog.path,
    failoverAttempt: requestLog.failoverAttempt,
    latencyMs: requestLog.latencyMs,
    totalMs: requestLog.totalMs,
    error: requestLog.error,
    upstreamRequestId: requestLog.upstreamRequestId,
    inputTokens: requestLog.inputTokens,
    outputTokens: requestLog.outputTokens,
    cacheReadTokens: requestLog.cacheReadTokens,
    cacheCreationTokens: requestLog.cacheCreationTokens,
    costUsd: requestLog.costUsd,
    rawRequestHeaders: requestLog.rawRequestHeaders,
    rawRequestBody: requestLog.rawRequestBody,
    rawResponseHeaders: requestLog.rawResponseHeaders,
    rawResponseBody: requestLog.rawResponseBody,
  };
}

function toRequestLogEntry(row: RequestRow): RequestLogEntry {
  return {
    id: row.id,
    account_id: row.accountId,
    account_name: row.accountName,
    api_key_id: row.apiKeyId,
    api_key_name: row.apiKeyName,
    ts: row.ts,
    status: row.status,
    model: row.model,
    outcome: row.outcome,
    method: row.method,
    path: row.path,
    failover_attempt: row.failoverAttempt,
    latency_ms: row.latencyMs,
    total_ms: row.totalMs,
    error: row.error,
    upstream_request_id: row.upstreamRequestId,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_creation_tokens: row.cacheCreationTokens,
    cost_usd: row.costUsd,
    raw_request_headers: row.rawRequestHeaders,
    raw_request_body: row.rawRequestBody,
    raw_response_headers: row.rawResponseHeaders,
    raw_response_body: row.rawResponseBody,
  };
}

interface RequestRow {
  id: number;
  accountId: string | null;
  accountName: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  ts: number;
  status: number | null;
  model: string | null;
  outcome: string | null;
  method: string | null;
  path: string | null;
  failoverAttempt: number;
  latencyMs: number | null;
  totalMs: number | null;
  error: string | null;
  upstreamRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  rawRequestHeaders: string | null;
  rawRequestBody: string | null;
  rawResponseHeaders: string | null;
  rawResponseBody: string | null;
}

function buildWhere(filter: RequestLogFilter): SQL | undefined {
  const conditions: SQL[] = [];

  if (filter.accountId) conditions.push(eq(requestLog.accountId, filter.accountId));
  if (filter.apiKeyId) conditions.push(eq(requestLog.apiKeyId, filter.apiKeyId));
  if (filter.outcome) conditions.push(eq(requestLog.outcome, filter.outcome));
  if (filter.model) conditions.push(eq(requestLog.model, filter.model));
  if (filter.since !== null && filter.since !== undefined) conditions.push(gte(requestLog.ts, filter.since));
  if (filter.until !== null && filter.until !== undefined) conditions.push(lte(requestLog.ts, filter.until));
  if (filter.search) {
    const term = `%${escapeLike(filter.search)}%`;
    const searchCondition = or(
      like(requestLog.path, term),
      like(requestLog.model, term),
      like(requestLog.error, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function escapeLike(value: string): string {
  return value;
}

function pruneRequestLog(now: number): void {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  orm.delete(requestLog).where(lt(requestLog.ts, now - thirtyDaysMs)).run();
}

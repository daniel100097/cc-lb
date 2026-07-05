import { accountDeviceId, accountRealUuid } from "../anthropic/account-config";
import { API_BASE } from "../anthropic/constants";
import { prepareRequestHeaders, sanitizeResponseHeaders } from "../anthropic/headers";
import { getValidAccessToken } from "../anthropic/token-manager";
import { isStrategyName, selectAccount } from "../balancer/strategies";
import { isAvailable, toState, type AccountState, type StrategyName } from "../balancer/types";
import { bumpRequestCount, listAccounts, updateAccount, type Account } from "../db/accounts";
import { validateApiKeySecret, type ApiKey } from "../db/api-keys";
import { getSettings, type Settings } from "../db/settings";
import { getSticky, setSticky, touchSticky } from "../db/sticky";
import { logRequest, updateRequestLogUsage } from "../db/request-log";
import { applyCooldown, clearRateLimit, parseRateLimit, recordMetadata } from "./rate-limit";
import { gatedUsedPercent } from "./usage-gate";
import { deriveStickyKey } from "./sticky-key";
import { extractUsageFromBody } from "./usage";

// Non-streaming requests may legitimately generate for minutes before any
// response bytes, so they keep one long deadline for the whole exchange.
const PROXY_TIMEOUT_MS = 30 * 60 * 1000;
// Streaming requests get response headers within seconds; a short header
// deadline lets a black-holed socket fail over quickly instead of hanging the
// client, while the total deadline only reaps streams that will never finish.
const STREAM_HEADER_TIMEOUT_MS = 30 * 1000;
const STREAM_TOTAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const RAW_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;

// Telemetry endpoints Claude Code hits that we answer locally.
const TELEMETRY_PATHS = new Set(["/api/event_logging/batch", "/api/system/package-manager"]);

export async function handleProxy(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const settings = getSettings();
  if (TELEMETRY_PATHS.has(path)) {
    const bodyBuf = settings.rawHttpLoggingEnabled && req.method !== "GET" && req.method !== "HEAD"
      ? await req.arrayBuffer()
      : null;
    const rawRequest = settings.rawHttpLoggingEnabled ? rawRequestSnapshot(req, url, bodyBuf) : null;
    const responseBody = JSON.stringify({ success: true });
    const responseHeaders = new Headers({ "content-type": "application/json" });
    logRequest({
      accountId: null,
      ts: Date.now(),
      status: 200,
      model: null,
      outcome: "telemetry",
      method: req.method,
      path,
      ...rawRequestFields(rawRequest),
      ...rawResponseFields(
        settings.rawHttpLoggingEnabled
          ? {
              headers: serializeResponseHead(200, "", responseHeaders),
              body: responseBody,
            }
          : null,
      ),
    });
    return new Response(responseBody, { status: 200, headers: responseHeaders });
  }

  const now = Date.now();
  const proxyAuth = authenticateProxyRequest(req, settings, now);
  if (proxyAuth.response) return proxyAuth.response;

  // Buffer body once so it can be replayed across failover attempts.
  const bodyBuf = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const rawRequest = settings.rawHttpLoggingEnabled ? rawRequestSnapshot(req, url, bodyBuf) : null;
  let parsedBody: unknown = null;
  if (bodyBuf && bodyBuf.byteLength > 0) {
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bodyBuf));
    } catch {
      /* not JSON; fine */
    }
  }

  const model = modelFromBody(parsedBody);
  let accounts = listAccounts();
  if (proxyAuth.apiKey?.account_scope_enabled === 1) {
    const assigned = new Set(proxyAuth.apiKey.assigned_account_ids);
    accounts = accounts.filter((account) => assigned.has(account.id));
  }
  const stickyKey = settings.stickySessions ? deriveStickyKey(req.headers, parsedBody) : null;
  const bodySignals = scanBodyIdentity(parsedBody);
  const stickyPinnedId = stickyKey ? getSticky(stickyKey, settings.stickyTtlMs, now) : null;
  const ordered = orderAccounts(accounts, settings, stickyKey, stickyPinnedId, now);
  if (ordered.length === 0) {
    return poolExhausted(accounts, now);
  }

  const tried = new Set<string>();
  let failoverAttempt = 0;

  for (const account of ordered) {
    if (tried.has(account.id)) continue;
    tried.add(account.id);

    const res = await attempt(account, req, url, bodyBuf, settings, {
      method: req.method,
      path: `${url.pathname}${url.search}`,
      model,
      apiKeyId: proxyAuth.apiKey?.id ?? null,
      failoverAttempt,
      parsedBody,
      bodySignals,
      wantsStream: isRecord(parsedBody) && parsedBody.stream === true,
      rawRequest,
    });
    if (res === null) {
      // Client already gone — don't burn the remaining accounts on failover.
      if (req.signal.aborted) return new Response(null, { status: 499 });
      failoverAttempt += 1;
      continue;
    }

    // Success — pin new sticky sessions; when a session was served by a
    // different account than its pin (home rate-limited or otherwise skipped),
    // move the session to the account that actually served it.
    if (stickyKey) {
      if (stickyPinnedId === account.id) {
        touchSticky(stickyKey, Date.now());
      } else {
        setSticky(stickyKey, account.id, Date.now());
      }
    }
    maybeRollSession(account, settings, Date.now());
    bumpRequestCount(account.id, Date.now());
    return res;
  }

  return poolExhausted(accounts, now);
}

/**
 * Returns a Response on success, or null to signal "try the next account".
 */
async function attempt(
  account: Account,
  req: Request,
  url: URL,
  bodyBuf: ArrayBuffer | null,
  settings: Settings,
  context: AttemptContext,
): Promise<Response | null> {
  const attemptStartedAt = performance.now();
  const now = Date.now();
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(account);
  } catch (error) {
    logRequest({
      accountId: account.id,
      apiKeyId: context.apiKeyId,
      ts: now,
      status: null,
      model: context.model,
      outcome: "token_error",
      method: context.method,
      path: context.path,
      failoverAttempt: context.failoverAttempt,
      totalMs: elapsedMs(attemptStartedAt),
      error: errorMessage(error),
      ...rawRequestFields(context.rawRequest),
    });
    return null;
  }

  const target = `${API_BASE}${url.pathname}${url.search}`;
  // Prefer the account's own Claude device id (machineID from its config dir) so
  // upstream sees a device fingerprint consistent with that account; fall back to
  // a manually configured override.
  const deviceIdOverride = accountDeviceId(account.id) ?? account.device_id_override;
  const headers = prepareRequestHeaders(req.headers, accessToken, deviceIdOverride, settings.userAgentOverride);
  const outboundBody = buildAttemptBody(bodyBuf, account, context, deviceIdOverride);
  const rawUpstreamRequest = context.rawRequest
    ? upstreamRequestSnapshot(req.method, target, headers, outboundBody)
    : null;

  let upstream: Response;
  let info;
  let latencyMs = 0;
  let overloadRetries = 0;
  try {
    const headerTimeoutMs = context.wantsStream ? STREAM_HEADER_TIMEOUT_MS : PROXY_TIMEOUT_MS;
    const totalTimeoutMs = context.wantsStream ? STREAM_TOTAL_TIMEOUT_MS : PROXY_TIMEOUT_MS;
    while (true) {
      const fetchStartedAt = performance.now();
      // The header deadline is cleared once upstream responds so it never cuts
      // the body; req.signal propagates client disconnects upstream.
      const headerAbort = new AbortController();
      const headerTimer = setTimeout(
        () => headerAbort.abort(new DOMException(`upstream headers not received within ${headerTimeoutMs}ms`, "TimeoutError")),
        headerTimeoutMs,
      );
      try {
        upstream = await fetch(target, {
          method: req.method,
          headers,
          body: outboundBody && outboundBody.byteLength > 0 ? outboundBody : undefined,
          signal: AbortSignal.any([req.signal, headerAbort.signal, AbortSignal.timeout(totalTimeoutMs)]),
        });
      } finally {
        clearTimeout(headerTimer);
      }
      latencyMs = elapsedMs(fetchStartedAt);
      info = parseRateLimit(upstream, Date.now());
      recordMetadata(account, info);

      if (upstream.status === 529 && info.resetTime === null && overloadRetries < settings.overloadRetryMax) {
        await discardBody(upstream);
        await sleep(overloadRetryDelayMs(overloadRetries));
        overloadRetries += 1;
        continue;
      }
      break;
    }
  } catch (error) {
    logRequest({
      accountId: account.id,
      apiKeyId: context.apiKeyId,
      ts: now,
      status: null,
      model: context.model,
      outcome: req.signal.aborted ? "client_abort" : "network_error",
      method: context.method,
      path: context.path,
      failoverAttempt: context.failoverAttempt,
      totalMs: elapsedMs(attemptStartedAt),
      error: errorMessage(error),
      ...rawRequestFields(context.rawRequest),
      ...rawUpstreamRequestFields(rawUpstreamRequest),
    });
    return null;
  }

  if (upstream.status === 401) {
    const rawResponse = await rawResponseSnapshot(upstream, context.rawRequest !== null);
    updateAccount(account.id, { needs_reauth: 1 });
    account.needs_reauth = 1;
    logRequest({
      accountId: account.id,
      apiKeyId: context.apiKeyId,
      ts: now,
      status: 401,
      model: context.model,
      outcome: "unauthorized",
      method: context.method,
      path: context.path,
      failoverAttempt: context.failoverAttempt,
      latencyMs,
      totalMs: elapsedMs(attemptStartedAt),
      upstreamRequestId: upstream.headers.get("request-id"),
      ...rawRequestFields(context.rawRequest),
      ...rawUpstreamRequestFields(rawUpstreamRequest),
      ...rawResponseFields(rawResponse),
    });
    if (!rawResponse) await discardBody(upstream);
    return null;
  }

  if (info.isRateLimited) {
    const rawResponse = await rawResponseSnapshot(upstream, context.rawRequest !== null);
    if (info.outOfCredits) {
      // Model/beta-scoped credit exhaustion — other models on this account still
      // work, so fail over without benching the account.
      logRequest({
        accountId: account.id,
        apiKeyId: context.apiKeyId,
        ts: now,
        status: upstream.status,
        model: context.model,
        outcome: "rate_limited",
        method: context.method,
        path: context.path,
        failoverAttempt: context.failoverAttempt,
        latencyMs,
        totalMs: elapsedMs(attemptStartedAt),
        upstreamRequestId: upstream.headers.get("request-id"),
        error: "out_of_credits",
        ...rawRequestFields(context.rawRequest),
        ...rawUpstreamRequestFields(rawUpstreamRequest),
        ...rawResponseFields(rawResponse),
      });
      if (!rawResponse) await discardBody(upstream);
      return null;
    }
    applyCooldown(account, info, settings, Date.now());
    logRequest({
      accountId: account.id,
      apiKeyId: context.apiKeyId,
      ts: now,
      status: upstream.status,
      model: context.model,
      outcome: "rate_limited",
      method: context.method,
      path: context.path,
      failoverAttempt: context.failoverAttempt,
      latencyMs,
      totalMs: elapsedMs(attemptStartedAt),
      upstreamRequestId: upstream.headers.get("request-id"),
      error: info.status,
      ...rawRequestFields(context.rawRequest),
      ...rawUpstreamRequestFields(rawUpstreamRequest),
      ...rawResponseFields(rawResponse),
    });
    if (!rawResponse) await discardBody(upstream);
    return null;
  }

  // Success.
  clearRateLimit(account, Date.now());
  const responseHeaders = sanitizeResponseHeaders(upstream.headers);
  const logId = logRequest({
    accountId: account.id,
    apiKeyId: context.apiKeyId,
    ts: now,
    status: upstream.status,
    model: context.model,
    outcome: upstream.status >= 400 ? "upstream_error" : "ok",
    method: context.method,
    path: context.path,
    failoverAttempt: context.failoverAttempt,
    latencyMs,
    upstreamRequestId: upstream.headers.get("request-id"),
    costUsd: billingCostUsd(upstream.headers),
    ...rawRequestFields(context.rawRequest),
    ...rawUpstreamRequestFields(rawUpstreamRequest),
    ...rawResponseFields(
      context.rawRequest
        ? { headers: serializeResponseHead(upstream.status, upstream.statusText, responseHeaders), body: null }
        : null,
    ),
  });

  if (!upstream.body) {
    updateRequestLogUsage(logId, { totalMs: elapsedMs(attemptStartedAt) });
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  const [clientBody, inspectionBody] = upstream.body.tee();
  const [usageBody, rawBody] = context.rawRequest ? inspectionBody.tee() : [inspectionBody, null];
  captureUsageInBackground({
    account,
    settings,
    logId,
    body: usageBody,
    contentType: upstream.headers.get("content-type"),
    billingCostUsd: billingCostUsd(upstream.headers),
    model: context.model,
    startedAt: attemptStartedAt,
  });
  if (rawBody) {
    captureRawResponseInBackground({
      logId,
      body: rawBody,
      contentType: responseHeaders.get("content-type"),
    });
  }

  return new Response(clientBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** Build the ordered candidate list: sticky-pinned first, then strategy order. */
function orderAccounts(
  accounts: Account[],
  settings: Settings,
  stickyKey: string | null,
  stickyPinnedId: string | null,
  now: number,
): Account[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const states = accounts.map((account) => toState(account, now));
  const available = states.filter((s) => isAvailable(s, now));
  if (available.length === 0) return [];

  const result: Account[] = [];
  const seen = new Set<string>();

  // Sticky pin first (if the pinned account is available).
  if (settings.stickySessions && stickyKey && stickyPinnedId) {
    if (available.some((s) => s.id === stickyPinnedId)) {
      const account = byId.get(stickyPinnedId);
      if (account) result.push(account);
      seen.add(stickyPinnedId);
    }
  }

  // Then strategy order over the remaining available pool. For sticky-keyed
  // requests any of these accounts can become the session's new home, so
  // accounts at/above the usage cutoff (5h session or weekly window) go last —
  // used only when no fresher account exists. The pinned account above is
  // exempt: an existing session keeps its home even past the cutoff.
  const pool = available.filter((s) => !seen.has(s.id));
  const saturated = new Set<string>();
  if (stickyKey) {
    for (const s of pool) {
      const used = gatedUsedPercent(byId.get(s.id)?.usage_windows ?? null, now);
      if (used !== null && used >= settings.newSessionUsageCutoffPercent) saturated.add(s.id);
    }
  }
  const strategy = isStrategyName(settings.strategy) ? settings.strategy : "priority";
  const chosen = [
    ...strategyOrder(pool.filter((s) => !saturated.has(s.id)), strategy, now),
    ...strategyOrder(pool.filter((s) => saturated.has(s.id)), strategy, now),
  ];
  for (const s of chosen) {
    const account = byId.get(s.id);
    if (account) result.push(account);
  }
  return result;
}

function strategyOrder(pool: AccountState[], strategy: StrategyName, now: number): AccountState[] {
  const chosen: AccountState[] = [];
  let remaining = [...pool];
  while (remaining.length > 0) {
    const pick = selectAccount(strategy, remaining, now);
    if (!pick) break;
    chosen.push(pick);
    remaining = remaining.filter((s) => s.id !== pick.id);
  }
  return chosen;
}

function maybeRollSession(account: Account, settings: Settings, now: number): void {
  const expired =
    account.session_start === null ||
    now - account.session_start > settings.sessionDurationMs ||
    (account.rate_limit_reset !== null && account.rate_limit_reset < now - 1000);
  if (expired) {
    updateAccount(account.id, { session_start: now, session_request_count: 0 });
    account.session_start = now;
    account.session_request_count = 0;
  }
}

interface AttemptContext {
  method: string;
  path: string;
  model: string | null;
  apiKeyId: string | null;
  failoverAttempt: number;
  parsedBody: unknown;
  bodySignals: BodyIdentitySignals;
  wantsStream: boolean;
  rawRequest: RawRequestSnapshot | null;
}

interface RawRequestSnapshot {
  headers: string;
  body: string | null;
}

interface RawResponseSnapshot {
  headers: string;
  body: string | null;
}

interface BodyIdentitySignals {
  hasDeviceId: boolean;
  hasAccountUuid: boolean;
}

// Conversation-content subtrees are never scanned or patched: identity slots
// don't live there, but the same key names can appear in replayed tool_use
// payloads, and rewriting those would corrupt history the model already emitted.
const IDENTITY_SKIP_KEYS = new Set(["messages", "system", "tools"]);

function scanBodyIdentity(value: unknown): BodyIdentitySignals {
  const signals: BodyIdentitySignals = { hasDeviceId: false, hasAccountUuid: false };
  scanIdentity(value, signals);
  return signals;
}

function scanIdentity(value: unknown, signals: BodyIdentitySignals): void {
  if (Array.isArray(value)) {
    for (const item of value) scanIdentity(item, signals);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (IDENTITY_SKIP_KEYS.has(key)) continue;
    if (isDeviceIdEntry(key, nested)) {
      signals.hasDeviceId = true;
    } else if (isAccountUuidEntry(key, nested)) {
      signals.hasAccountUuid = true;
    } else {
      scanIdentity(parseUserIdJson(key, nested) ?? nested, signals);
    }
  }
}

/** A device-id signal is a deviceid-ish key holding a non-empty primitive; object values are descended into instead. */
function isDeviceIdEntry(key: string, value: unknown): boolean {
  if (normalizeIdentityKey(key) !== "deviceid") return false;
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" || typeof value === "boolean";
}

/** An account-uuid slot is any accountuuid-ish key; the current value can be empty or the wrong type. */
function isAccountUuidEntry(key: string, _value: unknown): boolean {
  return normalizeIdentityKey(key) === "accountuuid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdentityKey(key: string): string {
  return key.replaceAll(/[-_]/g, "").toLowerCase();
}

/**
 * Claude Code packs identity into `metadata.user_id` as a JSON envelope
 * ({"device_id":…,"account_uuid":…,"session_id":…}). Parse it so identity
 * scanning/patching reaches inside; returns null when the value isn't that shape.
 */
function parseUserIdJson(key: string, value: unknown): Record<string, unknown> | unknown[] | null {
  if (normalizeIdentityKey(key) !== "userid" || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface IdentityPatch {
  deviceId: string | null;
  accountUuid: string | null;
}

/**
 * Per-attempt outbound body: patch device-id slots to the account's override and
 * account-uuid slots to the routed account's id — each only where the client
 * already sent that slot (including inside the metadata.user_id JSON envelope).
 * The shared bodyBuf stays pristine so failover to other accounts replays the
 * original.
 */
function buildAttemptBody(
  bodyBuf: ArrayBuffer | null,
  account: Account,
  context: AttemptContext,
  deviceIdOverride: string | null,
): ArrayBuffer | null {
  const patch: IdentityPatch = {
    deviceId: deviceIdOverride && context.bodySignals.hasDeviceId ? deviceIdOverride : null,
    // Prefer the account's real Anthropic accountUuid (from its Claude folder) so
    // the body matches a native Claude Code call; fall back to our internal id.
    accountUuid: context.bodySignals.hasAccountUuid ? (accountRealUuid(account.id) ?? account.id) : null,
  };
  if (!bodyBuf || (patch.deviceId === null && patch.accountUuid === null)) return bodyBuf;
  const patched = structuredClone(context.parsedBody);
  patchIdentityInPlace(patched, patch);
  const bytes = new TextEncoder().encode(JSON.stringify(patched));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Returns true when anything was rewritten, so user_id envelopes are only re-serialized on change. */
function patchIdentityInPlace(value: unknown, patch: IdentityPatch): boolean {
  if (Array.isArray(value)) {
    let mutated = false;
    for (const item of value) mutated = patchIdentityInPlace(item, patch) || mutated;
    return mutated;
  }
  if (!isRecord(value)) return false;
  let mutated = false;
  for (const [key, nested] of Object.entries(value)) {
    if (IDENTITY_SKIP_KEYS.has(key)) continue;
    if (patch.deviceId !== null && isDeviceIdEntry(key, nested)) {
      value[key] = patch.deviceId;
      mutated = true;
      continue;
    }
    if (patch.accountUuid !== null && isAccountUuidEntry(key, nested)) {
      value[key] = patch.accountUuid;
      mutated = true;
      continue;
    }
    const embedded = parseUserIdJson(key, nested);
    if (embedded !== null) {
      if (patchIdentityInPlace(embedded, patch)) {
        value[key] = JSON.stringify(embedded);
        mutated = true;
      }
      continue;
    }
    mutated = patchIdentityInPlace(nested, patch) || mutated;
  }
  return mutated;
}

interface ProxyAuthResult {
  apiKey: ApiKey | null;
  response: Response | null;
}

interface UsageCaptureInput {
  account: Account;
  settings: Settings;
  logId: number;
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
  billingCostUsd: number | null;
  model: string | null;
  startedAt: number;
}

function captureUsageInBackground(input: UsageCaptureInput): void {
  void (async () => {
    try {
      const usage = await extractUsageFromBody(input.body, input.contentType);
      const streamLimitError = usage.streamLimitError;
      if (streamLimitError) {
        applyCooldown(
          input.account,
          { isRateLimited: true, status: streamLimitError, resetTime: null, remaining: null, outOfCredits: false },
          input.settings,
          Date.now(),
        );
      }
      updateRequestLogUsage(input.logId, {
        outcome: streamLimitError ? "rate_limited" : undefined,
        totalMs: elapsedMs(input.startedAt),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: input.billingCostUsd,
        error: streamLimitError,
      });
    } catch (error) {
      updateRequestLogUsage(input.logId, {
        totalMs: elapsedMs(input.startedAt),
        error: errorMessage(error),
      });
    }
  })();
}

interface RawResponseCaptureInput {
  logId: number;
  body: ReadableStream<Uint8Array>;
  contentType: string | null;
}

function captureRawResponseInBackground(input: RawResponseCaptureInput): void {
  void (async () => {
    try {
      updateRequestLogUsage(input.logId, {
        rawResponseBody: await streamToRawBody(input.body, input.contentType),
      });
    } catch (error) {
      updateRequestLogUsage(input.logId, {
        rawResponseBody: `[raw response capture failed: ${errorMessage(error)}]`,
      });
    }
  })();
}

function rawRequestSnapshot(req: Request, url: URL, bodyBuf: ArrayBuffer | null): RawRequestSnapshot {
  return {
    headers: serializeRequestHead(req, url),
    body: bodyBuf ? bufferToRawBody(bodyBuf, req.headers.get("content-type")) : null,
  };
}

async function rawResponseSnapshot(response: Response, enabled: boolean): Promise<RawResponseSnapshot | null> {
  if (!enabled) return null;
  const headers = serializeResponseHead(response.status, response.statusText, sanitizeResponseHeaders(response.headers));
  const body = response.body ? bufferToRawBody(await response.arrayBuffer(), response.headers.get("content-type")) : null;
  return { headers, body };
}

function rawRequestFields(snapshot: RawRequestSnapshot | null) {
  return snapshot
    ? {
        rawRequestHeaders: snapshot.headers,
        rawRequestBody: snapshot.body,
      }
    : {};
}

/**
 * Snapshot of the outbound gateway→Anthropic request as actually sent: rewritten
 * headers, full target URL, and the per-attempt identity-patched body.
 */
function upstreamRequestSnapshot(
  method: string,
  target: string,
  headers: Headers,
  body: ArrayBuffer | null,
): RawRequestSnapshot {
  return {
    headers: serializeUpstreamRequestHead(method, target, headers),
    body: body && body.byteLength > 0 ? bufferToRawBody(body, headers.get("content-type")) : null,
  };
}

function serializeUpstreamRequestHead(method: string, url: string, headers: Headers): string {
  const redacted = new Headers(headers);
  const authorization = redacted.get("authorization");
  // The outbound authorization carries a live account OAuth token — never persist it.
  if (authorization) {
    redacted.set("authorization", `${authorization.split(/\s+/, 1)[0]} [redacted]`);
  }
  return JSON.stringify(
    {
      method,
      url,
      headers: headersObject(redacted),
    },
    null,
    2,
  );
}

function rawUpstreamRequestFields(snapshot: RawRequestSnapshot | null) {
  return snapshot
    ? {
        rawUpstreamRequestHeaders: snapshot.headers,
        rawUpstreamRequestBody: snapshot.body,
      }
    : {};
}

function rawResponseFields(snapshot: RawResponseSnapshot | null) {
  return snapshot
    ? {
        rawResponseHeaders: snapshot.headers,
        rawResponseBody: snapshot.body,
      }
    : {};
}

function serializeRequestHead(req: Request, url: URL): string {
  return JSON.stringify(
    {
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: headersObject(req.headers),
    },
    null,
    2,
  );
}

function serializeResponseHead(status: number, statusText: string, headers: Headers): string {
  return JSON.stringify(
    {
      status,
      statusText,
      headers: headersObject(headers),
    },
    null,
    2,
  );
}

function headersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function streamToRawBody(stream: ReadableStream<Uint8Array>, contentType: string | null): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = RAW_HTTP_BODY_LIMIT_BYTES - total;
      if (remaining > 0) {
        const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(chunk);
        total += chunk.byteLength;
      }
      if (value.byteLength > remaining) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = concatChunks(chunks, total);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return decodeRawBody(body, contentType, truncated);
}

function bufferToRawBody(body: ArrayBuffer, contentType: string | null): string {
  const truncated = body.byteLength > RAW_HTTP_BODY_LIMIT_BYTES;
  const slice = truncated ? body.slice(0, RAW_HTTP_BODY_LIMIT_BYTES) : body;
  return decodeRawBody(slice, contentType, truncated);
}

function decodeRawBody(body: ArrayBuffer, contentType: string | null, truncated: boolean): string {
  if (!isTextBody(contentType)) {
    return `[binary body omitted: ${body.byteLength}${truncated ? "+" : ""} bytes captured limit ${RAW_HTTP_BODY_LIMIT_BYTES}]`;
  }
  const text = new TextDecoder().decode(body);
  return truncated ? `${text}\n[truncated at ${RAW_HTTP_BODY_LIMIT_BYTES} bytes]` : text;
}

function isTextBody(contentType: string | null): boolean {
  if (!contentType) return true;
  const value = contentType.toLowerCase();
  return (
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript") ||
    value.includes("x-www-form-urlencoded") ||
    value.includes("event-stream")
  );
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function modelFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("model" in body)) return null;
  const model = body.model;
  return typeof model === "string" ? model : null;
}

function authenticateProxyRequest(
  req: Request,
  settings: Settings,
  now: number,
): ProxyAuthResult {
  const bearer = bearerToken(req.headers);
  if (!bearer) {
    return settings.apiKeyAuthEnabled
      ? { apiKey: null, response: proxyAuthError(401, "missing_api_key", "API key required.") }
      : { apiKey: null, response: null };
  }

  const validation = validateApiKeySecret(bearer, now);
  if (!validation.ok) {
    if (!settings.apiKeyAuthEnabled) return { apiKey: null, response: null };
    const status = validation.reason === "invalid" ? 401 : 403;
    return {
      apiKey: null,
      response: proxyAuthError(status, `api_key_${validation.reason}`, "API key rejected."),
    };
  }

  return { apiKey: validation.apiKey, response: null };
}

function bearerToken(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function proxyAuthError(status: 401 | 403, error: string, message: string): Response {
  const headers: Record<string, string> = {};
  if (status === 401) headers["www-authenticate"] = "Bearer";
  return Response.json({ error, message }, { status, headers });
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore cleanup failures */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function overloadRetryDelayMs(retryIndex: number): number {
  return Math.min(1000, 100 * 2 ** retryIndex + Math.floor(Math.random() * 100));
}

function billingCostUsd(headers: Headers): number | null {
  const raw = headers.get("anthropic-billing-cost");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function poolExhausted(accounts: Account[], now: number): Response {
  const details = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    reason: a.paused ? "paused" : a.needs_reauth === 1 ? "needs_reauth" : "rate_limited",
    available_at: a.rate_limited_until ?? null,
  }));
  const soonest = accounts
    .map((a) => a.rate_limited_until)
    .filter((t): t is number => t !== null && t > now)
    .sort((x, y) => x - y)[0];
  const headers: Record<string, string> = {};
  if (soonest) headers["retry-after"] = String(Math.ceil((soonest - now) / 1000));

  const reauthNames = details.filter((d) => d.reason === "needs_reauth").map((d) => d.name);
  const body: { error: string; accounts: typeof details; message?: string } = {
    error: "pool_exhausted",
    accounts: details,
  };
  if (reauthNames.length > 0) {
    const port = Number(process.env.PORT ?? 8484);
    const plural = reauthNames.length > 1;
    body.message =
      `Account${plural ? "s" : ""} ${reauthNames.join(", ")} need${plural ? "" : "s"} re-authentication. ` +
      `Open the dashboard at http://localhost:${port} and use Accounts -> Re-authenticate.`;
  }
  return Response.json(body, { status: 503, headers });
}

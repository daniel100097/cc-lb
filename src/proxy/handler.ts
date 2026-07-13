import { accountDeviceId, accountRealUuid } from "../anthropic/account-config";
import { installedClaudeVersion, matchesInstalledClaudeVersion } from "../anthropic/claude-version";
import { API_BASE } from "../anthropic/constants";
import {
  CLIENT_IP_HEADER,
  DEVICE_ID_HEADER,
  prepareRequestHeaders,
  sanitizeResponseHeaders,
} from "../anthropic/headers";
import { getValidAccessToken } from "../anthropic/token-manager";
import { isStrategyName, selectAccount } from "../balancer/strategies";
import { isAvailable, toState, type AccountState, type StrategyName } from "../balancer/types";
import { bumpRequestCount, listAccounts, updateAccount, type Account } from "../db/accounts";
import { validateApiKeySecret, type ApiKey } from "../db/api-keys";
import { getSettings, type Settings } from "../db/settings";
import { resolveServerPublicIp } from "../server-public-ip";
import { dashboardPort } from "../ports";
import {
  bindStickyClientDeviceId,
  claimPendingSticky,
  getStickyIdentity,
  promotePendingSticky,
  touchSticky,
  type StickyIdentityBinding,
} from "../db/sticky";
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

  const stickyKey = deriveStickyKey(req.headers);
  if (!stickyKey) return claudeCodeRequired();
  if (!matchesInstalledClaudeVersion(req.headers.get("user-agent"))) return claudeVersionRequired();

  const now = Date.now();
  const proxyAuth = authenticateProxyRequest(req, settings, now);
  if (proxyAuth.response) return proxyAuth.response;

  let stickyBinding = getStickyIdentity(stickyKey);
  if (stickyBinding?.status === "blocked") return sessionBlocked();

  let serverPublicIp: string | null = null;
  if (req.headers.has(CLIENT_IP_HEADER)) {
    serverPublicIp = await resolveServerPublicIp();
    if (!serverPublicIp) return serverPublicIpUnavailable();
  }

  // Buffer once for parsing, identity patching, and exact-byte forwarding.
  const bodyBuf = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const rawRequest = settings.rawHttpLoggingEnabled ? rawRequestSnapshot(req, url, bodyBuf) : null;
  let parsedBody: unknown = null;
  let bodyText: string | null = null;
  let bodyIsJson = false;
  let bodyHasDuplicateKeys = false;
  if (bodyBuf && bodyBuf.byteLength > 0) {
    bodyText = new TextDecoder().decode(bodyBuf);
    try {
      parsedBody = JSON.parse(bodyText);
      bodyIsJson = true;
      bodyHasDuplicateKeys = hasDuplicateJsonKeys(bodyText);
    } catch {
      /* not JSON; fine */
    }
  }

  const bodySignals = scanBodyIdentity(parsedBody);
  // Re-read after buffering so an operator block or concurrent first request
  // that won while this body was being read is observed before admission.
  stickyBinding = getStickyIdentity(stickyKey) ?? stickyBinding;
  if (stickyBinding?.status === "blocked") return sessionBlocked();

  const deviceValidation = validateClientDeviceIdentity(
    req.headers,
    parsedBody,
    bodyText,
    bodyIsJson,
    bodySignals,
    stickyBinding,
  );
  if (deviceValidation.response) return deviceValidation.response;
  if (bodyBuf && bodyBuf.byteLength > 0 && !bodyIsJson) return invalidClaudeRequestBody();
  if (
    bodyHasDuplicateKeys ||
    (bodySignals.userIdEnvelope !== null && hasDuplicateJsonKeys(bodySignals.userIdText ?? "")) ||
    (bodySignals.userIdText?.trimStart().startsWith("{") === true && bodySignals.userIdEnvelope === null)
  ) {
    return ambiguousClaudeRequestBody();
  }
  if (
    url.pathname === "/v1/messages" &&
    req.method === "POST" &&
    (!bodyIsJson || !isRecord(parsedBody) || !Array.isArray(parsedBody.messages))
  ) {
    return invalidClaudeRequestBody();
  }

  // Assistant history is admissible only after a substantive, history-free
  // message promoted the durable binding. Preflights never grant admission.
  if (hasAssistantMessage(parsedBody) && stickyBinding?.status !== "active") {
    return unknownSessionHistory();
  }

  const model = modelFromBody(parsedBody);
  let accounts = listAccounts();
  if (proxyAuth.apiKey?.account_scope_enabled === 1) {
    const assigned = new Set(proxyAuth.apiKey.assigned_account_ids);
    accounts = accounts.filter((account) => assigned.has(account.id));
  }
  const sessionId = stickyKey.slice("sid:".length);
  const hasDeviceIdSignal = req.headers.has(DEVICE_ID_HEADER) || bodySignals.hasDeviceId;
  let stickyPinnedId = stickyBinding?.accountId ?? null;
  let ordered = orderAccounts(accounts, settings, stickyKey, stickyPinnedId, now);

  // Every new session starts pending. This pins preflights without allowing a
  // quota/count-token request to make later assistant history look known.
  if (!stickyPinnedId && ordered[0]) {
    stickyBinding = claimPendingSticky(
      stickyKey,
      ordered[0].id,
      now,
      deviceValidation.clientDeviceId,
    );
    if (stickyBinding.status === "blocked") return sessionBlocked();
    stickyPinnedId = stickyBinding.accountId;
    ordered = orderAccounts(accounts, settings, stickyKey, stickyPinnedId, now);
  }

  if (stickyBinding && deviceValidation.clientDeviceId) {
    stickyBinding = bindStickyClientDeviceId(stickyKey, deviceValidation.clientDeviceId) ?? stickyBinding;
    if (stickyBinding.status === "blocked") return sessionBlocked();
    if (stickyBinding.clientDeviceId !== deviceValidation.clientDeviceId) return deviceIdentityMismatch();
  }

  // A concurrent claim may have supplied a different original device. Check
  // the winning durable value before any account credential or upstream work.
  if (stickyBinding?.clientDeviceId) {
    const winningValidation = validateClientDeviceIdentity(
      req.headers,
      parsedBody,
      bodyText,
      bodyIsJson,
      bodySignals,
      stickyBinding,
    );
    if (winningValidation.response) return winningValidation.response;
  }

  if (stickyBinding?.status === "pending" && isSubstantiveMessageRequest(req, url, parsedBody, bodyIsJson)) {
    stickyBinding = promotePendingSticky(stickyKey, now) ?? stickyBinding;
    if (stickyBinding.status === "blocked") return sessionBlocked();
  }

  // One last fail-closed read narrows the race with operator blocking/account
  // deletion and confirms that no concurrent request changed the winning
  // device identity before account credentials are touched.
  if (stickyPinnedId) {
    const finalBinding = getStickyIdentity(stickyKey);
    if (!finalBinding || finalBinding.status === "blocked" || finalBinding.accountId !== stickyPinnedId) {
      return sessionBlocked();
    }
    const finalDeviceValidation = validateClientDeviceIdentity(
      req.headers,
      parsedBody,
      bodyText,
      bodyIsJson,
      bodySignals,
      finalBinding,
    );
    if (finalDeviceValidation.response) return finalDeviceValidation.response;
  }

  const exhaustedAccounts = stickyPinnedId
    ? accounts.filter((account) => account.id === stickyPinnedId)
    : accounts;
  if (ordered.length === 0) {
    return poolExhausted(exhaustedAccounts, now);
  }

  const tried = new Set<string>();
  let failoverAttempt = 0;

  for (const account of ordered) {
    if (tried.has(account.id)) continue;
    tried.add(account.id);

    const accountUuid = accountRealUuid(account.id);
    if (!accountUuid) return accountIdentityMissing(account);
    const deviceId = accountDeviceId(account.id);
    if (hasDeviceIdSignal && !deviceId) return accountDeviceIdentityMissing(account);

    const res = await attempt(account, req, url, bodyBuf, settings, {
      method: req.method,
      path: `${url.pathname}${url.search}`,
      model,
      apiKeyId: proxyAuth.apiKey?.id ?? null,
      failoverAttempt,
      parsedBody,
      bodySignals,
      accountUuid,
      deviceId,
      serverPublicIp,
      sessionId,
      wantsStream: isRecord(parsedBody) && parsedBody.stream === true,
      rawRequest,
    });
    if (res === null) {
      // Stop immediately when the client is already gone.
      if (req.signal.aborted) return new Response(null, { status: 499 });
      failoverAttempt += 1;
      continue;
    }

    // Success only records activity; the account binding never changes.
    touchSticky(stickyKey, Date.now());
    maybeRollSession(account, settings, Date.now());
    bumpRequestCount(account.id, Date.now());
    return res;
  }

  return poolExhausted(exhaustedAccounts, now);
}

/**
 * Returns a Response on success, or null when the pinned attempt failed.
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
  const headers = prepareRequestHeaders(
    req.headers,
    accessToken,
    context.deviceId,
    settings.stripForwardedHeaders,
    context.serverPublicIp,
  );
  const outboundBody = buildAttemptBody(bodyBuf, context);
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
          keepalive: false,
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

  // An existing sticky pin is hard affinity: the session must not fall through
  // to any other account. If the pinned account is unavailable, there is no
  // candidate for this request.
  if (stickyKey && stickyPinnedId) {
    if (!available.some((s) => s.id === stickyPinnedId)) return [];
    const account = byId.get(stickyPinnedId);
    return account ? [account] : [];
  }

  // Then strategy order over the remaining available pool. For sticky-keyed
  // requests any of these accounts can become the session's new home, so
  // accounts at/above the usage cutoff (5h session or weekly window) go last —
  // used only when no fresher account exists. The pinned account above is
  // exempt: an existing session keeps its home even past the cutoff.
  const pool = available;
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
  accountUuid: string;
  deviceId: string | null;
  serverPublicIp: string | null;
  sessionId: string;
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
  hasSessionId: boolean;
  deviceId: string | null;
  userIdText: string | null;
  userIdEnvelope: Record<string, unknown> | null;
}

function scanBodyIdentity(value: unknown): BodyIdentitySignals {
  const empty: BodyIdentitySignals = {
    hasDeviceId: false,
    hasAccountUuid: false,
    hasSessionId: false,
    deviceId: null,
    userIdText: null,
    userIdEnvelope: null,
  };
  if (!isRecord(value) || !isRecord(value.metadata) || typeof value.metadata.user_id !== "string") return empty;
  const userIdText = value.metadata.user_id;
  const userIdEnvelope = parseUserIdJson(userIdText);
  if (!userIdEnvelope) return { ...empty, userIdText };
  const hasDeviceId = Object.hasOwn(userIdEnvelope, "device_id");
  return {
    hasDeviceId,
    hasAccountUuid: Object.hasOwn(userIdEnvelope, "account_uuid"),
    hasSessionId: Object.hasOwn(userIdEnvelope, "session_id"),
    deviceId: hasDeviceId ? identityPrimitive(userIdEnvelope.device_id) : null,
    userIdText,
    userIdEnvelope,
  };
}

function identityPrimitive(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAssistantMessage(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  return value.messages.some((message) => isRecord(message) && message.role === "assistant");
}

function isSubstantiveMessageRequest(
  req: Request,
  url: URL,
  value: unknown,
  bodyIsJson: boolean,
): boolean {
  return (
    req.method === "POST" &&
    url.pathname === "/v1/messages" &&
    bodyIsJson &&
    isRecord(value) &&
    Array.isArray(value.messages) &&
    !isQuotaProbe(value)
  );
}

function isQuotaProbe(value: Record<string, unknown>): boolean {
  if (value.max_tokens !== 1 || !Array.isArray(value.messages) || value.messages.length !== 1) return false;
  const message = value.messages[0];
  return isRecord(message) && message.role === "user" && message.content === "quota";
}

/**
 * Claude Code packs identity into `metadata.user_id` as a JSON envelope
 * ({"device_id":…,"account_uuid":…,"session_id":…). Only this exact path
 * is an expected body identity location in the direct captures.
 */
function parseUserIdJson(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

interface DeviceValidation {
  clientDeviceId: string | null;
  response: Response | null;
}

function validateClientDeviceIdentity(
  headers: Headers,
  body: unknown,
  bodyText: string | null,
  bodyIsJson: boolean,
  signals: BodyIdentitySignals,
  binding: StickyIdentityBinding | null,
): DeviceValidation {
  if (containsOffPathDeviceField(body, bodyText, signals)) {
    return { clientDeviceId: null, response: unexpectedDeviceIdentity() };
  }

  const rawHeaderDeviceId = headers.get(DEVICE_ID_HEADER);
  const headerDeviceId = rawHeaderDeviceId?.trim() || null;
  if (headers.has(DEVICE_ID_HEADER) && (!headerDeviceId || headerDeviceId.includes(","))) {
    return { clientDeviceId: null, response: invalidDeviceIdentity() };
  }
  if (signals.hasDeviceId && !signals.deviceId) {
    return { clientDeviceId: null, response: invalidDeviceIdentity() };
  }
  if (headerDeviceId && signals.deviceId && headerDeviceId !== signals.deviceId) {
    return { clientDeviceId: null, response: deviceIdentityMismatch() };
  }

  const requestDeviceId = headerDeviceId ?? signals.deviceId;
  if (binding?.clientDeviceId && requestDeviceId && binding.clientDeviceId !== requestDeviceId) {
    return { clientDeviceId: requestDeviceId, response: deviceIdentityMismatch() };
  }
  const originalDeviceId = binding?.clientDeviceId ?? requestDeviceId;
  if (
    originalDeviceId &&
    hasUnexpectedDeviceIdentity(headers, body, bodyText, bodyIsJson, signals, originalDeviceId)
  ) {
    return { clientDeviceId: requestDeviceId, response: unexpectedDeviceIdentity() };
  }
  return { clientDeviceId: requestDeviceId, response: null };
}

function hasUnexpectedDeviceIdentity(
  headers: Headers,
  body: unknown,
  bodyText: string | null,
  bodyIsJson: boolean,
  signals: BodyIdentitySignals,
  deviceId: string,
): boolean {
  for (const [name, value] of headers) {
    if (name.toLowerCase() === DEVICE_ID_HEADER) continue;
    if (name.includes(deviceId) || value.includes(deviceId)) return true;
  }

  // Direct message envelopes contain the original device literal exactly once;
  // count-token bodies contain it zero times. Raw counting catches values hidden
  // by duplicate JSON keys before JSON.parse discarded them.
  const expectedRawOccurrences = signals.deviceId === deviceId ? 1 : 0;
  if (bodyText && countOccurrences(bodyText, deviceId) !== expectedRawOccurrences) return true;
  if (!bodyIsJson) return bodyText?.includes(deviceId) ?? false;
  return bodyContainsUnexpectedDeviceId(body, deviceId, signals, []);
}

function bodyContainsUnexpectedDeviceId(
  value: unknown,
  deviceId: string,
  signals: BodyIdentitySignals,
  path: string[],
): boolean {
  if (
    path.length === 2 &&
    path[0] === "metadata" &&
    path[1] === "user_id" &&
    value === signals.userIdText &&
    signals.userIdEnvelope
  ) {
    return envelopeContainsUnexpectedDeviceId(signals.userIdEnvelope, deviceId);
  }
  if (typeof value === "string") return value.includes(deviceId);
  if (typeof value === "number" || typeof value === "boolean") return String(value).includes(deviceId);
  if (Array.isArray(value)) {
    return value.some((item, index) => bodyContainsUnexpectedDeviceId(item, deviceId, signals, [...path, String(index)]));
  }
  if (!isRecord(value)) return false;

  for (const [key, nested] of Object.entries(value)) {
    if (key.includes(deviceId)) return true;
    if (bodyContainsUnexpectedDeviceId(nested, deviceId, signals, [...path, key])) return true;
  }
  return false;
}

function envelopeContainsUnexpectedDeviceId(envelope: Record<string, unknown>, deviceId: string): boolean {
  for (const [key, value] of Object.entries(envelope)) {
    if (key.includes(deviceId)) return true;
    if (key === "device_id" && identityPrimitive(value) === deviceId) continue;
    if (unknownValueContains(value, deviceId)) return true;
  }
  return false;
}

function unknownValueContains(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (typeof value === "number" || typeof value === "boolean") return String(value).includes(needle);
  if (Array.isArray(value)) return value.some((item) => unknownValueContains(item, needle));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => key.includes(needle) || unknownValueContains(nested, needle));
}

function containsOffPathDeviceField(body: unknown, bodyText: string | null, signals: BodyIdentitySignals): boolean {
  // An unescaped device-id property in the outer body is never an expected
  // Claude Code identity field. This also catches duplicate keys JSON.parse hid.
  if (bodyText && /(?:^|[,{]\s*)"device(?:_|-)?id"\s*:/i.test(bodyText)) return true;
  if (containsDeviceKey(body)) return true;
  if (!signals.userIdEnvelope || !signals.userIdText) return false;

  const expectedExactKeys = signals.hasDeviceId ? 1 : 0;
  if (countJsonDeviceKeys(signals.userIdText) !== expectedExactKeys) return true;
  return Object.entries(signals.userIdEnvelope).some(([key, value]) => {
    if (key === "device_id") return false;
    return normalizeIdentityKey(key) === "deviceid" || containsDeviceKey(value);
  });
}

function containsDeviceKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDeviceKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) => normalizeIdentityKey(key) === "deviceid" || containsDeviceKey(nested),
  );
}

function countJsonDeviceKeys(value: string): number {
  return Array.from(value.matchAll(/(?:^|[,{]\s*)"device_id"\s*:/g)).length;
}

function normalizeIdentityKey(key: string): string {
  return key.replaceAll(/[-_]/g, "").toLowerCase();
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const found = value.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

/**
 * JSON.parse keeps only one value for duplicate object keys. Walk the original
 * JSON grammar as well so an overwritten `messages`, `role`, or identity value
 * cannot evade admission or device-location checks.
 */
function hasDuplicateJsonKeys(value: string): boolean {
  let offset = 0;
  let duplicate = false;

  function skipWhitespace(): void {
    while (/\s/.test(value[offset] ?? "")) offset += 1;
  }

  function readString(): string {
    const start = offset;
    offset += 1;
    while (offset < value.length) {
      const char = value[offset];
      if (char === "\\") {
        offset += 2;
        continue;
      }
      offset += 1;
      if (char === '"') {
        const parsed: unknown = JSON.parse(value.slice(start, offset));
        if (typeof parsed !== "string") throw new Error("invalid JSON string");
        return parsed;
      }
    }
    throw new Error("unterminated JSON string");
  }

  function readValue(): void {
    skipWhitespace();
    const char = value[offset];
    if (char === "{") {
      readObject();
      return;
    }
    if (char === "[") {
      readArray();
      return;
    }
    if (char === '"') {
      readString();
      return;
    }
    while (offset < value.length && !/[\s,\]}]/.test(value[offset] ?? "")) offset += 1;
  }

  function readObject(): void {
    offset += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (value[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < value.length) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) duplicate = true;
      keys.add(key);
      skipWhitespace();
      if (value[offset] !== ":") throw new Error("invalid JSON object");
      offset += 1;
      readValue();
      skipWhitespace();
      if (value[offset] === "}") {
        offset += 1;
        return;
      }
      if (value[offset] !== ",") throw new Error("invalid JSON object");
      offset += 1;
    }
    throw new Error("unterminated JSON object");
  }

  function readArray(): void {
    offset += 1;
    skipWhitespace();
    if (value[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < value.length) {
      readValue();
      skipWhitespace();
      if (value[offset] === "]") {
        offset += 1;
        return;
      }
      if (value[offset] !== ",") throw new Error("invalid JSON array");
      offset += 1;
    }
    throw new Error("unterminated JSON array");
  }

  try {
    readValue();
    skipWhitespace();
    return duplicate || offset !== value.length;
  } catch {
    // Callers only use this after JSON.parse succeeded. Any disagreement is
    // treated as ambiguous and therefore fails closed.
    return true;
  }
}

/**
 * Per-attempt outbound body: synchronize device/account/session identity slots
 * to the pinned account and validated session header. Each slot is rewritten
 * only where direct Claude Code sent it, including metadata.user_id envelopes.
 * The shared bodyBuf stays pristine so account-specific rewriting never
 * mutates the original request.
 */
function buildAttemptBody(
  bodyBuf: ArrayBuffer | null,
  context: AttemptContext,
): ArrayBuffer | null {
  const signals = context.bodySignals;
  if (!bodyBuf || !signals.userIdEnvelope || !isRecord(context.parsedBody)) return bodyBuf;
  const envelope = structuredClone(signals.userIdEnvelope);
  let changed = false;
  if (signals.hasDeviceId && context.deviceId && envelope.device_id !== context.deviceId) {
    envelope.device_id = context.deviceId;
    changed = true;
  }
  if (signals.hasAccountUuid && envelope.account_uuid !== context.accountUuid) {
    envelope.account_uuid = context.accountUuid;
    changed = true;
  }
  if (signals.hasSessionId && envelope.session_id !== context.sessionId) {
    envelope.session_id = context.sessionId;
    changed = true;
  }
  if (!changed) return bodyBuf;

  const patched = structuredClone(context.parsedBody);
  if (!isRecord(patched.metadata)) return bodyBuf;
  patched.metadata.user_id = JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(JSON.stringify(patched));
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
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
          {
            isRateLimited: true,
            status: streamLimitError,
            resetTime: null,
            remaining: null,
            fiveHour: { utilization: null, reset: null },
            sevenDay: { utilization: null, reset: null },
            outOfCredits: false,
          },
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

function claudeCodeRequired(): Response {
  return Response.json(
    {
      error: "claude_code_required",
      message: "Only Claude Code requests with x-claude-code-session-id are accepted.",
    },
    { status: 403 },
  );
}

function claudeVersionRequired(): Response {
  const version = installedClaudeVersion();
  return Response.json(
    {
      error: "claude_code_version_mismatch",
      message: version
        ? `Claude Code ${version} is required to match the server.`
        : "The server's Claude Code version is unavailable.",
    },
    { status: 403 },
  );
}

function serverPublicIpUnavailable(): Response {
  return Response.json(
    {
      error: "server_public_ip_unavailable",
      message: "The server public IP could not be resolved; client-ip was not forwarded.",
    },
    { status: 503 },
  );
}

function sessionBlocked(): Response {
  return Response.json(
    {
      error: "session_blocked",
      message: "This Claude Code session was blocked by an operator.",
    },
    { status: 403 },
  );
}

function unknownSessionHistory(): Response {
  return Response.json(
    {
      error: "unknown_session_history",
      message: "An unknown Claude Code session cannot start with assistant history.",
    },
    { status: 403 },
  );
}

function invalidClaudeRequestBody(): Response {
  return Response.json(
    {
      error: "invalid_claude_request_body",
      message: "Claude Code requests require valid, inspectable JSON; message requests also require a messages array.",
    },
    { status: 400 },
  );
}

function ambiguousClaudeRequestBody(): Response {
  return Response.json(
    {
      error: "ambiguous_claude_request_body",
      message: "Claude Code request JSON must not contain duplicate or malformed identity keys.",
    },
    { status: 400 },
  );
}

function invalidDeviceIdentity(): Response {
  return Response.json(
    {
      error: "invalid_device_identity",
      message: "Claude Code device identity must be one non-empty value.",
    },
    { status: 403 },
  );
}

function deviceIdentityMismatch(): Response {
  return Response.json(
    {
      error: "device_identity_mismatch",
      message: "This Claude Code session is already bound to a different client device identity.",
    },
    { status: 403 },
  );
}

function unexpectedDeviceIdentity(): Response {
  return Response.json(
    {
      error: "unexpected_device_identity",
      message: "The client device ID appeared outside a recognized Claude Code identity field.",
    },
    { status: 403 },
  );
}

function accountIdentityMissing(account: Account): Response {
  return Response.json(
    {
      error: "account_identity_missing",
      message: `Account ${account.name} is missing accountUuid in its .claude.json file.`,
      account: { id: account.id, name: account.name },
    },
    { status: 503 },
  );
}

function accountDeviceIdentityMissing(account: Account): Response {
  return Response.json(
    {
      error: "account_device_identity_missing",
      message: `Account ${account.name} is missing machineID in its .claude.json file.`,
      account: { id: account.id, name: account.name },
    },
    { status: 503 },
  );
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
    const port = dashboardPort();
    const plural = reauthNames.length > 1;
    body.message =
      `Account${plural ? "s" : ""} ${reauthNames.join(", ")} need${plural ? "" : "s"} re-authentication. ` +
      `Open the dashboard at http://localhost:${port} and use Accounts -> Re-authenticate.`;
  }
  return Response.json(body, { status: 503, headers });
}

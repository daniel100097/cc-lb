import { accountDeviceId, accountRealUuid } from "../anthropic/account-config";
import { API_BASE } from "../anthropic/constants";
import { prepareRequestHeaders, sanitizeResponseHeaders } from "../anthropic/headers";
import { getValidAccessToken } from "../anthropic/token-manager";
import { isStrategyName, selectAccount } from "../balancer/strategies";
import { isAvailable, toState, type AccountState } from "../balancer/types";
import { bumpRequestCount, listAccounts, updateAccount, type Account } from "../db/accounts";
import { validateApiKeySecret, type ApiKey } from "../db/api-keys";
import { getSettings, type Settings } from "../db/settings";
import { getSticky, setSticky, touchSticky } from "../db/sticky";
import { logRequest, updateRequestLogUsage } from "../db/request-log";
import { applyCooldown, clearRateLimit, parseRateLimit, recordMetadata } from "./rate-limit";
import { deriveStickyKey } from "./sticky-key";
import { extractUsageFromBody } from "./usage";

const PROXY_TIMEOUT_MS = 30 * 60 * 1000;

// Telemetry endpoints Claude Code hits that we answer locally.
const TELEMETRY_PATHS = new Set(["/api/event_logging/batch", "/api/system/package-manager"]);

export async function handleProxy(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (TELEMETRY_PATHS.has(path)) {
    logRequest({
      accountId: null,
      ts: Date.now(),
      status: 200,
      model: null,
      outcome: "telemetry",
      method: req.method,
      path,
    });
    return Response.json({ success: true });
  }

  const settings = getSettings();
  const now = Date.now();
  const proxyAuth = authenticateProxyRequest(req, settings, now);
  if (proxyAuth.response) return proxyAuth.response;

  // Buffer body once so it can be replayed across failover attempts.
  const bodyBuf = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
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
    });
    if (res === null) {
      failoverAttempt += 1;
      continue;
    }

    // Success — pin new sticky sessions, but don't overwrite a temporarily unavailable home pin.
    if (stickyKey) {
      if (stickyPinnedId === account.id) {
        touchSticky(stickyKey, Date.now());
      } else if (stickyPinnedId === null) {
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
    });
    return null;
  }

  const target = `${API_BASE}${url.pathname}${url.search}`;
  // Prefer the account's own Claude device id (machineID from its config dir) so
  // upstream sees a device fingerprint consistent with that account; fall back to
  // a manually configured override.
  const deviceIdOverride = accountDeviceId(account.id) ?? account.device_id_override;
  const headers = prepareRequestHeaders(req.headers, accessToken, deviceIdOverride);
  const outboundBody = buildAttemptBody(bodyBuf, account, context, deviceIdOverride);

  let upstream: Response;
  let info;
  let latencyMs = 0;
  let overloadRetries = 0;
  try {
    while (true) {
      const fetchStartedAt = performance.now();
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: outboundBody && outboundBody.byteLength > 0 ? outboundBody : undefined,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
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
      outcome: "network_error",
      method: context.method,
      path: context.path,
      failoverAttempt: context.failoverAttempt,
      totalMs: elapsedMs(attemptStartedAt),
      error: errorMessage(error),
    });
    return null;
  }

  if (upstream.status === 401) {
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
    });
    await discardBody(upstream);
    return null;
  }

  if (info.isRateLimited) {
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
      });
      await discardBody(upstream);
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
    });
    await discardBody(upstream);
    return null;
  }

  // Success.
  clearRateLimit(account, Date.now());
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
  });

  const responseHeaders = sanitizeResponseHeaders(upstream.headers);
  if (!upstream.body) {
    updateRequestLogUsage(logId, { totalMs: elapsedMs(attemptStartedAt) });
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  const [clientBody, usageBody] = upstream.body.tee();
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

  // Then strategy order over the remaining available pool.
  const pool = available.filter((s) => !seen.has(s.id));
  const chosen: AccountState[] = [];
  let remaining = [...pool];
  const strategy = isStrategyName(settings.strategy) ? settings.strategy : "priority";
  while (remaining.length > 0) {
    const pick = selectAccount(strategy, remaining, now);
    if (!pick) break;
    chosen.push(pick);
    remaining = remaining.filter((s) => s.id !== pick.id);
  }
  for (const s of chosen) {
    const account = byId.get(s.id);
    if (account) result.push(account);
  }
  return result;
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
}

interface BodyIdentitySignals {
  hasDeviceId: boolean;
  hasAccountUuid: boolean;
}

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

/** An account-uuid slot is an accountuuid-ish key holding a string; empty strings count so we can fill them. */
function isAccountUuidEntry(key: string, value: unknown): boolean {
  return normalizeIdentityKey(key) === "accountuuid" && typeof value === "string";
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

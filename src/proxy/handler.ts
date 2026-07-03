import { API_BASE } from "../anthropic/constants";
import { prepareRequestHeaders, sanitizeResponseHeaders } from "../anthropic/headers";
import { checkRefreshTokenHealth } from "../anthropic/token-health";
import { getValidAccessToken } from "../anthropic/token-manager";
import { isStrategyName, selectAccount } from "../balancer/strategies";
import { isAvailable, toState, type AccountState } from "../balancer/types";
import { bumpRequestCount, listAccounts, updateAccount, type Account } from "../db/accounts";
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
  const accounts = listAccounts();
  const stickyKey = settings.stickySessions ? deriveStickyKey(req.headers, parsedBody) : null;
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
      failoverAttempt,
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
  const headers = prepareRequestHeaders(req.headers, accessToken);

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
        body: bodyBuf && bodyBuf.byteLength > 0 ? bodyBuf : undefined,
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
    applyCooldown(account, info, settings, Date.now());
    logRequest({
      accountId: account.id,
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
  failoverAttempt: number;
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
          { isRateLimited: true, status: streamLimitError, resetTime: null, remaining: null },
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
    reason: a.paused ? "paused" : a.needs_reauth === 1 || checkRefreshTokenHealth(a, now).requiresReauth ? "needs_reauth" : "rate_limited",
    available_at: a.rate_limited_until ?? null,
  }));
  const soonest = accounts
    .map((a) => a.rate_limited_until)
    .filter((t): t is number => t !== null && t > now)
    .sort((x, y) => x - y)[0];
  const headers: Record<string, string> = {};
  if (soonest) headers["retry-after"] = String(Math.ceil((soonest - now) / 1000));
  return Response.json({ error: "pool_exhausted", accounts: details }, { status: 503, headers });
}

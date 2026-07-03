import { API_BASE } from "../anthropic/constants";
import { prepareRequestHeaders, sanitizeResponseHeaders } from "../anthropic/headers";
import { checkRefreshTokenHealth } from "../anthropic/token-health";
import { getValidAccessToken } from "../anthropic/token-manager";
import { isStrategyName, selectAccount } from "../balancer/strategies";
import { isAvailable, toState, type AccountState } from "../balancer/types";
import { bumpRequestCount, listAccounts, updateAccount, type Account } from "../db/accounts";
import { getSettings, type Settings } from "../db/settings";
import { getSticky, setSticky } from "../db/sticky";
import { logRequest } from "../db/request-log";
import { applyCooldown, clearRateLimit, parseRateLimit, recordMetadata } from "./rate-limit";
import { deriveStickyKey } from "./sticky-key";

const PROXY_TIMEOUT_MS = 30 * 60 * 1000;

// Telemetry endpoints Claude Code hits that we answer locally.
const TELEMETRY_PATHS = new Set(["/api/event_logging/batch", "/api/system/package-manager"]);

export async function handleProxy(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (TELEMETRY_PATHS.has(path)) {
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

  const accounts = listAccounts();
  const ordered = orderAccounts(accounts, settings, req.headers, parsedBody, now);
  if (ordered.length === 0) {
    return poolExhausted(accounts, now);
  }

  const stickyKey = settings.stickySessions ? deriveStickyKey(req.headers, parsedBody) : null;
  const tried = new Set<string>();

  for (const account of ordered) {
    if (tried.has(account.id)) continue;
    tried.add(account.id);

    const res = await attempt(account, req, url, bodyBuf, settings, now);
    if (res === null) continue; // failover

    // Success — pin sticky, update counters.
    if (stickyKey) setSticky(stickyKey, account.id, Date.now());
    bumpRequestCount(account.id, Date.now());
    maybeRollSession(account, settings, Date.now());
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
  now: number,
): Promise<Response | null> {
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(account);
  } catch {
    logRequest({ accountId: account.id, ts: now, status: null, outcome: "token_error" });
    return null;
  }

  const target = `${API_BASE}${url.pathname}${url.search}`;
  const headers = prepareRequestHeaders(req.headers, accessToken);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: bodyBuf && bodyBuf.byteLength > 0 ? bodyBuf : undefined,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch {
    logRequest({ accountId: account.id, ts: now, status: null, outcome: "network_error" });
    return null;
  }

  const info = parseRateLimit(upstream, Date.now());
  recordMetadata(account, info);

  if (upstream.status === 401) {
    updateAccount(account.id, { needs_reauth: 1 });
    account.needs_reauth = 1;
    logRequest({ accountId: account.id, ts: now, status: 401, outcome: "unauthorized" });
    return null;
  }

  if (info.isRateLimited) {
    applyCooldown(account, info, settings, Date.now());
    logRequest({ accountId: account.id, ts: now, status: upstream.status, outcome: "rate_limited" });
    return null;
  }

  // Success.
  clearRateLimit(account);
  logRequest({ accountId: account.id, ts: now, status: upstream.status, outcome: "ok" });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: sanitizeResponseHeaders(upstream.headers),
  });
}

/** Build the ordered candidate list: sticky-pinned first, then strategy order. */
function orderAccounts(
  accounts: Account[],
  settings: Settings,
  headers: Headers,
  body: unknown,
  now: number,
): Account[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const states = accounts.map((account) => toState(account, now));
  const available = states.filter((s) => isAvailable(s, now));
  if (available.length === 0) return [];

  const result: Account[] = [];
  const seen = new Set<string>();

  // Sticky pin first (if the pinned account is available).
  if (settings.stickySessions) {
    const key = deriveStickyKey(headers, body);
    if (key) {
      const pinned = getSticky(key, settings.stickyTtlMs, now);
      if (pinned && available.some((s) => s.id === pinned)) {
        const account = byId.get(pinned);
        if (account) result.push(account);
        seen.add(pinned);
      }
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

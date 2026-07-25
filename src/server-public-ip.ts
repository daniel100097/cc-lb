import { isIP } from "node:net";
import { proxyFetchInit } from "./egress-proxy";

const PUBLIC_IP_ENDPOINT = "https://one.one.one.one/cdn-cgi/trace";
const PUBLIC_IP_CACHE_MS = 30_000;
const PUBLIC_IP_FAILURE_BACKOFF_MS = 5_000;
const PUBLIC_IP_TIMEOUT_MS = 5_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Clock = () => number;

interface CachedPublicIp {
  ip: string;
  expiresAt: number;
}

// Each account's egress path has its own public IP, so cache/backoff state is
// keyed by proxy URL ("" = the server's own direct path).
const cached = new Map<string, CachedPublicIp>();
const retryAfter = new Map<string, number>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Resolve the public IP of an account's outbound network path — its proxy's exit
 * IP, or the server's own when the account goes direct.
 * Expired values are never used when a refresh fails: callers must fail closed.
 */
export async function resolveEgressPublicIp(
  proxyUrl: string | null = null,
  fetchImpl: FetchLike = globalThis.fetch,
  clock: Clock = Date.now,
): Promise<string | null> {
  const key = proxyUrl ?? "";
  const now = clock();
  const hit = cached.get(key);
  if (hit && hit.expiresAt > now) return hit.ip;
  cached.delete(key);
  if ((retryAfter.get(key) ?? 0) > now) return null;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = fetchEgressPublicIp(proxyUrl, fetchImpl)
    .then((ip) => {
      const resolvedAt = clock();
      if (ip) {
        cached.set(key, { ip, expiresAt: resolvedAt + PUBLIC_IP_CACHE_MS });
        retryAfter.delete(key);
      } else {
        retryAfter.set(key, resolvedAt + PUBLIC_IP_FAILURE_BACKOFF_MS);
      }
      return ip;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

async function fetchEgressPublicIp(proxyUrl: string | null, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const response = await fetchImpl(PUBLIC_IP_ENDPOINT, {
      headers: { accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
      ...proxyFetchInit(proxyUrl),
    });
    if (!response.ok) return null;

    const trace = await response.text();
    const candidate = /^ip=(.+)$/m.exec(trace)?.[1]?.trim() ?? "";
    if (isIP(candidate) === 0) return null;

    return candidate;
  } catch {
    return null;
  }
}

/** Reset process-local resolver state between tests. */
export function resetServerPublicIpCacheForTests(): void {
  cached.clear();
  retryAfter.clear();
  inFlight.clear();
}

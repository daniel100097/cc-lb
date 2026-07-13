import { isIP } from "node:net";

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

let cached: CachedPublicIp | null = null;
let retryAfter = 0;
let inFlight: Promise<string | null> | null = null;

/**
 * Resolve the public IP used by this server's outbound network path.
 * Expired values are never used when a refresh fails: callers must fail closed.
 */
export async function resolveServerPublicIp(
  fetchImpl: FetchLike = globalThis.fetch,
  clock: Clock = Date.now,
): Promise<string | null> {
  const now = clock();
  if (cached && cached.expiresAt > now) return cached.ip;
  cached = null;
  if (retryAfter > now) return null;

  if (inFlight) return inFlight;
  inFlight = fetchServerPublicIp(fetchImpl)
    .then((ip) => {
      const resolvedAt = clock();
      if (ip) {
        cached = { ip, expiresAt: resolvedAt + PUBLIC_IP_CACHE_MS };
        retryAfter = 0;
      } else {
        retryAfter = resolvedAt + PUBLIC_IP_FAILURE_BACKOFF_MS;
      }
      return ip;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function fetchServerPublicIp(fetchImpl: FetchLike): Promise<string | null> {
  try {
    const response = await fetchImpl(PUBLIC_IP_ENDPOINT, {
      headers: { accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
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
  cached = null;
  retryAfter = 0;
  inFlight = null;
}

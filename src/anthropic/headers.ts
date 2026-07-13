import { OAUTH_BETA_HEADER } from "./constants";

export const DEVICE_ID_HEADER = "x-device-id";
export const CLIENT_IP_HEADER = "client-ip";

/** Headers that reveal the client's IP or proxy chain to upstream. */
export const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "via",
] as const;

/**
 * Rewrite client request headers for forwarding to Anthropic with our OAuth token.
 * Mirrors better-ccflare's AnthropicProvider.prepareHeaders.
 *
 * The account's real machineID is header-scoped: it only rewrites an x-device-id
 * header the client already sent. Body device-id patching happens per-attempt.
 *
 * The validated Claude Code user-agent is forwarded unchanged.
 */
export function prepareRequestHeaders(
  incoming: Headers,
  accessToken: string,
  accountDeviceId?: string | null,
  stripForwardedHeaders = false,
  serverPublicIp?: string | null,
): Headers {
  const h = new Headers(incoming);

  // Strip the client's key credential; authorization is overwritten below.
  h.delete("x-api-key");

  if (stripForwardedHeaders) {
    for (const header of FORWARDED_HEADERS) h.delete(header);
  }
  if (incoming.has(CLIENT_IP_HEADER)) {
    // Never trust a client-supplied IP. Preserve the direct request shape by
    // rewriting this field only when the client actually sent it.
    if (serverPublicIp) h.set(CLIENT_IP_HEADER, serverPublicIp);
    else h.delete(CLIENT_IP_HEADER);
  }

  h.set("authorization", `Bearer ${accessToken}`);
  if (incoming.has(DEVICE_ID_HEADER)) {
    if (accountDeviceId) h.set(DEVICE_ID_HEADER, accountDeviceId);
    else h.delete(DEVICE_ID_HEADER);
  }
  // Ensure the OAuth beta flag is present.
  const beta = h.get("anthropic-beta");
  if (beta) {
    if (!beta.split(",").map((s) => s.trim()).includes(OAUTH_BETA_HEADER)) {
      h.set("anthropic-beta", `${beta},${OAUTH_BETA_HEADER}`);
    }
  } else {
    h.set("anthropic-beta", OAUTH_BETA_HEADER);
  }

  // Hop-by-hop / host.
  h.delete("host");
  h.delete("content-length"); // recomputed by fetch from the body
  h.set("connection", "close");

  return h;
}

/**
 * Sanitize upstream response headers before forwarding to the client.
 * Bun already decompressed the body, so leaving content-encoding causes ZlibError.
 */
export function sanitizeResponseHeaders(upstream: Headers): Headers {
  const h = new Headers(upstream);
  h.delete("content-encoding");
  h.delete("content-length");
  h.delete("transfer-encoding");
  return h;
}

import { OAUTH_BETA_HEADER } from "./constants";

export const DEVICE_ID_HEADER = "x-device-id";

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
 * Device-id override is header-scoped: it only rewrites an x-device-id header the
 * client already sent. Body device-id patching happens per-attempt in the proxy handler.
 *
 * User-agent override replaces the client's user-agent wholesale (e.g. to present
 * the Claude Code version installed on the gateway host regardless of the client).
 */
export function prepareRequestHeaders(
  incoming: Headers,
  accessToken: string,
  deviceIdOverride?: string | null,
  userAgentOverride?: string | null,
  stripForwardedHeaders = false,
): Headers {
  const h = new Headers(incoming);

  // Strip client credentials — we inject our own.
  h.delete("authorization");
  h.delete("x-api-key");

  if (stripForwardedHeaders) {
    for (const header of FORWARDED_HEADERS) h.delete(header);
  }

  h.set("authorization", `Bearer ${accessToken}`);
  if (deviceIdOverride && incoming.has(DEVICE_ID_HEADER)) {
    h.set(DEVICE_ID_HEADER, deviceIdOverride);
  }
  const userAgent = userAgentOverride?.trim();
  if (userAgent) {
    h.set("user-agent", userAgent);
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

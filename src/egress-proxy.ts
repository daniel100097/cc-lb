// Per-account outbound (egress) HTTP proxy. Named "egress" throughout to keep it
// distinct from cc-lb's own inbound proxy listener (see proxy/handler.ts).
//
// One account's proxy has to cover every HTTP path that account touches: the
// upstream /v1/* forward, the egress-IP lookup behind the client-ip header, and
// the Claude Code CLI panes (login + /usage probe), which read HTTP_PROXY /
// HTTPS_PROXY. A configured proxy is never bypassed — callers spread these
// helpers unconditionally so an unset proxy is the only way to go direct.

/** Proxy schemes Bun's fetch and Claude Code's HTTP(S)_PROXY both understand. */
const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Validate and normalize an operator-supplied proxy URL.
 * Throws with a dashboard-readable message; callers surface it through tRPC.
 */
export function parseEgressProxyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Proxy URL is required.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Proxy URL must be a full URL, for example http://user:pass@127.0.0.1:8888.");
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new Error("Proxy URL must use http:// or https://. SOCKS proxies are not supported.");
  }
  if (!url.hostname) throw new Error("Proxy URL must include a host.");
  if (url.search || url.hash) throw new Error("Proxy URL must not include a query string or fragment.");
  if (url.pathname !== "" && url.pathname !== "/") throw new Error("Proxy URL must not include a path.");

  // Canonical form for http(s): host, optional credentials, optional port, bare "/".
  return url.toString();
}

/** Redact the password for display, logging, and API responses. */
export function maskProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (!url.password) return url.toString();
    url.password = "***";
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

/** Spreadable fetch init. Empty for a null proxy, so direct traffic is unchanged. */
export function proxyFetchInit(proxyUrl: string | null | undefined): { proxy?: string } {
  return proxyUrl ? { proxy: proxyUrl } : {};
}

/**
 * Proxy env vars for a Claude Code CLI pane. Both cases are set: Node honors the
 * uppercase pair, and assorted tooling in the CLI's process tree reads lowercase.
 */
export function proxyEnvVars(proxyUrl: string | null | undefined): Record<string, string> {
  if (!proxyUrl) return {};
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
  };
}

/** Env var names buildTmuxClaudeCommand must export into a pane. */
export const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

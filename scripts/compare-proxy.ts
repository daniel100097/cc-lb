// Transparent logging proxy for comparing what Claude Code sends directly vs.
// what cc-lb forwards upstream. It buffers each request, prints the
// identity-relevant headers and body fields (the ones cc-lb rewrites), dumps the
// full exchange to a file for exact diffing, then forwards upstream unchanged.
//
// Two capture points:
//   1. Direct — point Claude Code straight at this proxy:
//        ANTHROPIC_BASE_URL=http://localhost:8788 PROXY_LABEL=direct bun run scripts/compare-proxy.ts
//   2. Via cc-lb — point cc-lb's upstream at this proxy, Claude Code at cc-lb:
//        ANTHROPIC_API_BASE=http://localhost:8788 (on cc-lb)
//        PROXY_LABEL=cc-lb PROXY_PORT=8788 bun run scripts/compare-proxy.ts
//
// Then diff the dumped request files:  diff data/compare/direct-*.http data/compare/cc-lb-*.http
//
// Env:
//   PROXY_PORT     listen port                (default 8788)
//   PROXY_TARGET   upstream base URL          (default https://api.anthropic.com)
//   PROXY_OUT      dir to dump exchanges       (default ./data/compare; set "" to disable)
//   PROXY_LABEL    tag for filenames + logs    (default "proxy")
//   PROXY_BODY     "1" to also log response bodies (default off; noisy for SSE)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PROXY_PORT ?? 8788);
const TARGET = (process.env.PROXY_TARGET ?? "https://api.anthropic.com").replace(/\/+$/, "");
const OUT = process.env.PROXY_OUT ?? "./data/compare";
const LABEL = process.env.PROXY_LABEL ?? "proxy";
const LOG_RESPONSE_BODY = process.env.PROXY_BODY === "1";

// Headers worth comparing verbatim (identity / routing fingerprint). Everything
// else is still dumped to the file; these are highlighted in the terminal.
const IDENTITY_HEADERS = [
  "authorization",
  "x-api-key",
  "x-device-id",
  "anthropic-beta",
  "anthropic-version",
  "anthropic-dangerous-direct-browser-access",
  "user-agent",
  "x-app",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
];

// Hop-by-hop headers not forwarded upstream.
const STRIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection"]);

if (OUT) mkdirSync(OUT, { recursive: true });

let seq = 0;

function redact(name: string, value: string): string {
  if (name === "authorization") {
    const token = value.replace(/^Bearer\s+/i, "");
    return `Bearer <redacted len=${token.length} …${token.slice(-4)}>`;
  }
  if (name === "x-api-key") return `<redacted len=${value.length} …${value.slice(-4)}>`;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findIdentityBodyFields(body: unknown, out: string[] = [], path = ""): string[] {
  if (Array.isArray(body)) {
    body.forEach((item, i) => findIdentityBodyFields(item, out, `${path}[${i}]`));
    return out;
  }
  if (!isRecord(body)) return out;
  for (const [key, value] of Object.entries(body)) {
    const here = path ? `${path}.${key}` : key;
    const norm = key.toLowerCase().replace(/[_-]/g, "");
    if (norm === "deviceid" || norm === "accountuuid" || key === "user_id" || norm === "userid") {
      out.push(`${here} = ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
    if (typeof value === "object" && value !== null) findIdentityBodyFields(value, out, here);
  }
  return out;
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const n = ++seq;
    const bodyBuf = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
    const bodyText = bodyBuf && bodyBuf.byteLength > 0 ? new TextDecoder().decode(bodyBuf) : "";

    // Terminal summary.
    const lines: string[] = [`\n━━━ #${n} ${req.method} ${url.pathname}${url.search}  [${LABEL}] ━━━`];
    lines.push("identity headers:");
    for (const name of IDENTITY_HEADERS) {
      const value = req.headers.get(name);
      if (value !== null) lines.push(`  ${name}: ${redact(name, value)}`);
    }
    if (bodyText) {
      const parsed = tryParseJson(bodyText);
      if (parsed !== undefined) {
        const fields = findIdentityBodyFields(parsed);
        if (fields.length > 0) {
          lines.push("body identity:");
          for (const field of fields) lines.push(`  ${field}`);
        }
        if (isRecord(parsed) && typeof parsed.model === "string") lines.push(`  model: ${parsed.model}`);
      }
    }
    console.log(lines.join("\n"));

    // Full request dump for exact diffing (token value redacted).
    if (OUT) dumpRequest(n, req, url, bodyText);

    // Forward upstream unchanged (minus hop-by-hop headers).
    const forwardHeaders = new Headers();
    for (const [name, value] of req.headers) {
      if (!STRIP_REQUEST_HEADERS.has(name.toLowerCase())) forwardHeaders.set(name, value);
    }

    let upstream: Response;
    try {
      upstream = await fetch(`${TARGET}${url.pathname}${url.search}`, {
        method: req.method,
        headers: forwardHeaders,
        body: bodyBuf,
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  → upstream error: ${message}`);
      return new Response(`proxy upstream error: ${message}`, { status: 502 });
    }

    const rl = upstream.headers.get("anthropic-ratelimit-unified-status");
    const remaining = upstream.headers.get("anthropic-ratelimit-unified-remaining");
    const reset = upstream.headers.get("anthropic-ratelimit-unified-reset");
    console.log(
      `  → ${upstream.status}` +
        (rl ? `  ratelimit=${rl} remaining=${remaining ?? "?"} reset=${reset ?? "?"}` : ""),
    );

    // Strip encoding headers: Bun decompresses the body, so a leftover
    // content-encoding would make the client fail to parse it.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    if (LOG_RESPONSE_BODY && upstream.body) {
      const [a, b] = upstream.body.tee();
      void new Response(a).text().then((text) => console.log(`  ↩ body: ${text.slice(0, 2_000)}`));
      return new Response(b, { status: upstream.status, headers: responseHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
});

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function dumpRequest(n: number, req: Request, url: URL, bodyText: string): void {
  const headerLines: string[] = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
  for (const [name, value] of [...req.headers].sort((a, b) => a[0].localeCompare(b[0]))) {
    headerLines.push(`${name}: ${redact(name, value)}`);
  }
  const pretty = (() => {
    const parsed = tryParseJson(bodyText);
    return parsed === undefined ? bodyText : JSON.stringify(parsed, null, 2);
  })();
  const seqStr = String(n).padStart(4, "0");
  const file = join(OUT, `${LABEL}-${seqStr}.http`);
  writeFileSync(file, `${headerLines.join("\n")}\n\n${pretty}\n`);
}

console.log(
  `compare-proxy [${LABEL}] on http://localhost:${String(server.port)} → ${TARGET}` +
    (OUT ? `  (dumping to ${OUT}/)` : ""),
);

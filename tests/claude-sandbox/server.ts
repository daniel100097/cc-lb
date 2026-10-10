import {
  FAKE_ACCESS_TOKEN,
  FAKE_PROFILE,
  FAKE_REFRESH_TOKEN,
  FAKE_SCOPES,
  REFRESHED_ACCESS_TOKEN,
} from "./fixtures";

export type Scenario =
  | "text"
  | "tool"
  | "refresh"
  | "unauthorized"
  | "rate-limit"
  | "overload"
  | "truncated-stream";

export interface ResponseFixture {
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

export interface Exchange extends ResponseFixture {
  timestamp: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
}

export interface FakeApiOptions {
  scenario?: Scenario;
  text?: string;
  toolPath?: string;
  onExchange?: (exchange: Exchange) => void;
  transformResponse?: (exchange: Exchange) => ResponseFixture | Promise<ResponseFixture>;
}

const TOOL_ID = "toolu_sandbox_read_0001";
const usage = {
  input_tokens: 20,
  output_tokens: 8,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function error(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return json({ type: "error", error: { type, message } }, status, headers);
}

function event(type: string, value: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Offline fixtures only: this handler never forwards requests to another server. */
export function createFakeApi(options: FakeApiOptions = {}) {
  const scenario = options.scenario ?? "text";
  const traffic: Exchange[] = [];
  let messageCount = 0;
  let rejectedAccessToken = false;

  async function respond(request: Request, requestBody: string): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/cdn-cgi/trace") {
      return new Response("fl=sandbox\nip=203.0.113.10\nloc=US\ntls=TLSv1.3\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    // Acknowledge only these known telemetry routes; unexpected routes remain visible.
    if (request.method === "POST" && ["/api/event_logging/batch", "/v1/logs"].includes(path)) {
      return new Response(null, { status: 204 });
    }

    let body: Record<string, unknown> = {};
    if (requestBody) {
      try {
        const parsed: unknown = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(requestBody))
          : JSON.parse(requestBody);
        if (!isRecord(parsed)) {
          throw new Error("Expected a JSON object");
        }
        body = parsed;
      } catch {
        return error(400, "invalid_request_error", "Sandbox expected a JSON object or form body");
      }
    }

    if (request.method === "POST" && path === "/v1/oauth/token") {
      if (body.grant_type !== "refresh_token" || body.refresh_token !== FAKE_REFRESH_TOKEN) {
        return json({ error: "invalid_grant", error_description: "Unknown sandbox refresh token" }, 400);
      }
      return json({
        access_token: REFRESHED_ACCESS_TOKEN,
        refresh_token: FAKE_REFRESH_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        scope: FAKE_SCOPES.join(" "),
      });
    }

    const protectedPath = path.startsWith("/api/oauth/") || path.startsWith("/v1/messages");
    if (protectedPath) {
      const token = request.headers.get("authorization");
      const allowedTokens = rejectedAccessToken || scenario === "refresh"
        ? [REFRESHED_ACCESS_TOKEN]
        : [FAKE_ACCESS_TOKEN, REFRESHED_ACCESS_TOKEN];
      if (!allowedTokens.some((value) => token === `Bearer ${value}`)) {
        return error(401, "authentication_error", "Sandbox requires its synthetic OAuth access token");
      }
    }

    if (request.method === "GET" && path === "/api/oauth/profile") {
      return json(FAKE_PROFILE);
    }
    if (request.method === "GET" && path === "/api/oauth/usage") {
      return json({
        five_hour: { utilization: 0, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 0, resets_at: "2099-01-01T00:00:00Z" },
        seven_day_opus: null,
        seven_day_sonnet: null,
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      });
    }
    if (["GET", "POST"].includes(request.method) && path === "/api/oauth/validate") {
      return json({ valid: true });
    }
    if (request.method === "POST" && path === "/v1/messages/count_tokens") {
      return json({ input_tokens: usage.input_tokens });
    }
    if (request.method === "GET" && path === "/v1/mcp_servers") {
      return json({ data: [], has_more: false });
    }

    if (request.method === "POST" && path === "/v1/messages") {
      messageCount += 1;
      const headers = { "request-id": `req_sandbox_${messageCount}` };
      if (messageCount === 1) {
        if (scenario === "unauthorized") {
          rejectedAccessToken = true;
          return error(401, "authentication_error", "OAuth token has expired. Please refresh your existing token.", headers);
        }
        if (scenario === "rate-limit") {
          return error(429, "rate_limit_error", "Synthetic sandbox rate limit", { ...headers, "retry-after": "0" });
        }
        if (scenario === "overload") {
          return error(529, "overloaded_error", "Synthetic sandbox overload", { ...headers, "retry-after": "0" });
        }
      }

      const hasToolResult = Array.isArray(body.messages) && body.messages.some((message: unknown) =>
        isRecord(message) && message.role === "user" && Array.isArray(message.content) && message.content.some((block: unknown) =>
          isRecord(block) && block.type === "tool_result" && block.tool_use_id === TOOL_ID,
        ),
      );
      const useTool = scenario === "tool" && !hasToolResult;
      const text = options.text ?? "SANDBOX_RESPONSE_OK";
      const toolInput = { file_path: options.toolPath ?? "/workspace/fixture.txt" };
      const content = useTool
        ? { type: "tool_use", id: TOOL_ID, name: "Read", input: toolInput }
        : { type: "text", text };
      const message = {
        id: `msg_sandbox_${messageCount}`,
        type: "message",
        role: "assistant",
        model: typeof body.model === "string" ? body.model : "claude-sonnet-4-6",
        content: [content],
        stop_reason: useTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage,
      };
      if (body.stream !== true) return json(message, 200, headers);

      let stream = event("message_start", {
        message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } },
      });
      stream += event("content_block_start", {
        index: 0,
        content_block: useTool ? { ...content, input: {} } : { type: "text", text: "" },
      });
      stream += event("content_block_delta", {
        index: 0,
        delta: useTool
          ? { type: "input_json_delta", partial_json: JSON.stringify(toolInput) }
          : { type: "text_delta", text },
      });
      // EOF before message_delta/message_stop exercises the CLI's interrupted-stream path.
      if (!(scenario === "truncated-stream" && messageCount === 1)) {
        stream += event("content_block_stop", { index: 0 });
        stream += event("message_delta", {
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        });
        stream += event("message_stop", {});
      }
      return new Response(stream, {
        headers: { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }

    console.error(`[claude-sandbox] Unhandled route: ${request.method} ${url.origin}${path}`);
    return error(404, "not_found_error", `No sandbox fixture for ${request.method} ${path}`);
  }

  return {
    traffic,
    async fetch(request: Request): Promise<Response> {
      const timestamp = new Date().toISOString();
      const requestBody = await request.text();
      let response = await respond(request, requestBody);
      const exchange: Exchange = {
        timestamp,
        method: request.method,
        url: request.url,
        requestHeaders: Object.fromEntries(request.headers),
        requestBody,
        responseStatus: response.status,
        responseHeaders: Object.fromEntries(response.headers),
        responseBody: await response.clone().text(),
      };
      if (options.transformResponse && request.method === "POST" && new URL(request.url).pathname === "/v1/messages") {
        try {
          const fixture = await options.transformResponse({ ...exchange });
          if (!Number.isInteger(fixture.responseStatus) || fixture.responseStatus < 200 || fixture.responseStatus > 599) {
            throw new Error("Response status must be an integer from 200 to 599");
          }
          if ([204, 205, 304].includes(fixture.responseStatus) && fixture.responseBody !== "") {
            throw new Error(`HTTP ${fixture.responseStatus} requires an empty responseBody`);
          }
          response = new Response([204, 205, 304].includes(fixture.responseStatus) ? null : fixture.responseBody, {
            status: fixture.responseStatus, headers: fixture.responseHeaders,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          console.error(`[claude-sandbox] Response experiment failed: ${message}`);
          response = error(502, "sandbox_error", message, { "x-should-retry": "false" });
        }
        exchange.responseStatus = response.status;
        exchange.responseHeaders = Object.fromEntries(response.headers);
        exchange.responseBody = await response.clone().text();
      }
      // Credentials in these captures are synthetic fixtures, never host credentials.
      traffic.push(exchange);
      options.onExchange?.(exchange);
      return response;
    },
  };
}

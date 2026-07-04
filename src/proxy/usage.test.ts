import { describe, expect, test } from "bun:test";
import { extractUsageFromJson, extractUsageFromSse } from "./usage";

describe("usage extraction", () => {
  test("extracts usage from JSON responses", () => {
    const usage = extractUsageFromJson(
      JSON.stringify({
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }),
    );
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadTokens).toBe(3);
    expect(usage.cacheCreationTokens).toBe(4);
    expect(usage.streamLimitError).toBeNull();
  });

  test("extracts usage and rate-limit errors from SSE", () => {
    const usage = extractUsageFromSse(`event: message_start
data: {"message":{"usage":{"input_tokens":11,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}}}

event: message_delta
data: {"usage":{"output_tokens":31}}

event: error
data: {"error":{"type":"rate_limit_error"}}

`);
    expect(usage.inputTokens).toBe(11);
    expect(usage.outputTokens).toBe(31);
    expect(usage.cacheReadTokens).toBe(5);
    expect(usage.cacheCreationTokens).toBe(7);
    expect(usage.streamLimitError).toBe("rate_limit_error");
  });
});

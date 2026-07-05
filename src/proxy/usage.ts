export interface UsageExtractionResult {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  streamLimitError: "rate_limit_error" | "overloaded_error" | null;
}

interface UsageShape {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

const EMPTY_USAGE: UsageExtractionResult = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  streamLimitError: null,
};

export async function extractUsageFromBody(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
): Promise<UsageExtractionResult> {
  if (!body) return EMPTY_USAGE;
  const text = await new Response(body).text();
  if (contentType?.includes("text/event-stream")) {
    return extractUsageFromSse(text);
  }
  if (contentType?.includes("application/json") || looksLikeJson(text)) {
    return extractUsageFromJson(text);
  }
  return EMPTY_USAGE;
}

export function extractUsageFromJson(text: string): UsageExtractionResult {
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return EMPTY_USAGE;
    const usage = isRecord(parsed.usage) ? usageFromRecord(parsed.usage) : EMPTY_USAGE;
    const streamLimitError = limitErrorFromRecord(parsed);
    return { ...usage, streamLimitError };
  } catch {
    return EMPTY_USAGE;
  }
}

export function extractUsageFromSse(text: string): UsageExtractionResult {
  let currentEvent = "";
  const data: string[] = [];
  const result: UsageExtractionResult = { ...EMPTY_USAGE };

  function flush() {
    if (data.length === 0) {
      currentEvent = "";
      return;
    }
    const payload = data.join("\n");
    mergeSsePayload(result, currentEvent, payload);
    currentEvent = "";
    data.length = 0;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("event:")) {
      currentEvent = rawLine.slice("event:".length).trim();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      data.push(rawLine.slice("data:".length).trimStart());
    }
  }
  flush();

  return result;
}

function mergeSsePayload(result: UsageExtractionResult, event: string, payload: string): void {
  if (payload === "[DONE]") return;

  try {
    const parsed = JSON.parse(payload);
    if (!isRecord(parsed)) return;
    const streamLimitError = limitErrorFromRecord(parsed);
    if (streamLimitError) result.streamLimitError = streamLimitError;

    const usageRecord = usageRecordFromEvent(event, parsed);
    if (usageRecord) mergeUsage(result, usageFromRecord(usageRecord));
  } catch {
    return;
  }
}

function usageRecordFromEvent(event: string, parsed: Record<string, unknown>): UsageShape | null {
  if (isRecord(parsed.usage)) return parsed.usage;
  if (event === "message_start" && isRecord(parsed.message) && isRecord(parsed.message.usage)) {
    return parsed.message.usage;
  }
  if (event === "message_delta" && isRecord(parsed.usage)) return parsed.usage;
  return null;
}

function usageFromRecord(record: UsageShape): UsageExtractionResult {
  return {
    inputTokens: numeric(record.input_tokens),
    outputTokens: numeric(record.output_tokens),
    cacheReadTokens: numeric(record.cache_read_input_tokens),
    cacheCreationTokens: numeric(record.cache_creation_input_tokens),
    streamLimitError: null,
  };
}

function mergeUsage(target: UsageExtractionResult, patch: UsageExtractionResult): void {
  target.inputTokens = patch.inputTokens ?? target.inputTokens;
  target.outputTokens = patch.outputTokens ?? target.outputTokens;
  target.cacheReadTokens = patch.cacheReadTokens ?? target.cacheReadTokens;
  target.cacheCreationTokens = patch.cacheCreationTokens ?? target.cacheCreationTokens;
}

function limitErrorFromRecord(record: Record<string, unknown>): UsageExtractionResult["streamLimitError"] {
  const error = record.error;
  if (!isRecord(error)) return null;
  const type = error.type;
  return type === "rate_limit_error" || type === "overloaded_error" ? type : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

import type { Exchange, ResponseFixture } from "./server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateResponseFixture(value: unknown): ResponseFixture {
  if (!isRecord(value) || !Number.isInteger(value.responseStatus) ||
      typeof value.responseStatus !== "number" || value.responseStatus < 200 || value.responseStatus > 599) {
    throw new Error("responseStatus must be an integer from 200 to 599");
  }
  if (!isRecord(value.responseHeaders)) {
    throw new Error("responseHeaders must be an object of string values");
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value.responseHeaders)) {
    if (typeof header !== "string") throw new Error("responseHeaders must be an object of string values");
    headers[name] = header;
  }
  if (typeof value.responseBody !== "string") throw new Error("responseBody must be a string");
  if ([204, 205, 304].includes(value.responseStatus) && value.responseBody !== "") {
    throw new Error(`HTTP ${value.responseStatus} requires an empty responseBody`);
  }
  new Headers(headers); // Reject invalid HTTP header names/values before consuming a pending request.
  return {
    responseStatus: value.responseStatus,
    responseHeaders: { ...headers },
    responseBody: value.responseBody,
  };
}

/** Accept a response object, an array, or captured JSONL; replay only messages responses. */
export function parseReplay(source: string): ResponseFixture[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    value = source.split("\n").filter(line => line.trim()).map((line, index) => {
      try { const parsed: unknown = JSON.parse(line); return parsed; }
      catch { throw new Error(`Invalid replay JSON on line ${index + 1}`); }
    });
  }
  const records = Array.isArray(value) ? value : [value];
  const fixtures: ResponseFixture[] = [];
  for (const [index, record] of records.entries()) {
    if (isRecord(record) && (record.truncated === true || record.incomplete === true || record.complete === false || record.captureComplete === false)) {
      throw new Error(`Replay exchange ${index + 1} is marked truncated or incomplete`);
    }
    if (isRecord(record) && ("method" in record || "url" in record)) {
      if (typeof record.method !== "string" || typeof record.url !== "string") {
        throw new Error(`Replay exchange ${index + 1} requires method and url`);
      }
      let path: string;
      try { path = new URL(record.url).pathname; }
      catch { throw new Error(`Replay exchange ${index + 1} has an invalid url`); }
      if (record.method !== "POST" || path !== "/v1/messages") continue;
    }
    fixtures.push(validateResponseFixture(record));
  }
  if (!fixtures.length) throw new Error("Replay contains no POST /v1/messages responses");
  return fixtures;
}

export async function loadReplay(path: string): Promise<ResponseFixture[]> {
  return parseReplay(await Bun.file(path).text());
}

interface ExperimentOptions {
  replay?: ResponseFixture[];
  interactive?: boolean;
  port?: number;
}

export function createExperiment(options: ExperimentOptions = {}) {
  const replay = options.replay?.map(validateResponseFixture);
  let replayIndex = 0;
  let nextId = 1;
  let stopped = false;
  const pending = new Map<string, {
    exchange: Exchange;
    resolve: (response: ResponseFixture) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const control = options.interactive ? Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 8789,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/pending") {
        const first = pending.entries().next().value;
        return Response.json(first ? { id: first[0], ...first[1].exchange } : null);
      }
      if (request.method !== "POST" || url.pathname !== "/reply") {
        return Response.json({ error: "Use GET /pending or POST /reply" }, { status: 404 });
      }
      try {
        const value: unknown = await request.json();
        if (!isRecord(value) || typeof value.id !== "string") throw new Error("Reply requires a string id from /pending");
        const entry = pending.get(value.id);
        if (!entry) return Response.json({ error: `No pending request with id ${value.id}` }, { status: 409 });
        const fixture = validateResponseFixture(value);
        clearTimeout(entry.timer);
        pending.delete(value.id);
        entry.resolve(fixture);
        return Response.json({ ok: true, id: value.id });
      } catch (cause) {
        return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 400 });
      }
    },
  }) : undefined;

  return {
    controlUrl: control ? `http://127.0.0.1:${control.port}` : undefined,
    async transformResponse(this: void, exchange: Exchange): Promise<ResponseFixture> {
      if (stopped) throw new Error("Response experiment stopped");
      const fixture = replay ? replay[replayIndex++] : validateResponseFixture(exchange);
      if (!fixture) throw new Error(`Replay exhausted after ${replay?.length ?? 0} responses; refusing to invent a response`);
      if (!options.interactive) return fixture;
      const id = String(nextId++);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Interactive reply ${id} timed out after 10 minutes`));
        }, 10 * 60_000);
        timer.unref();
        pending.set(id, { exchange: { ...exchange, ...fixture }, resolve, reject, timer });
        console.error(`[claude-sandbox] Waiting for response ${id}; run control.ts pending, edit JSON, then control.ts reply`);
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Response experiment stopped before its pending reply"));
      }
      pending.clear();
      await control?.stop(true);
    },
  };
}

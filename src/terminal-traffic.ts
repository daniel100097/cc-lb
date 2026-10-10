import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDashboardAuthenticated, unauthorizedApiResponse } from "./auth";
import { API_BASE } from "./anthropic/constants";
import { getAccount } from "./db/accounts";
import { proxyFetchInit } from "./egress-proxy";

const BODY_LIMIT = 2 * 1024 * 1024;
const SESSION_LIMIT = 20 * 1024 * 1024;
const ENTRY_LIMIT = 200;
const REDACTED = "[redacted]";
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"];
const SECRET_NAME = /^(?:authorization|proxy[-_]?authorization|(?:x[-_])?api[-_]?key|cookie|set[-_]?cookie|(?:access|refresh|id|auth)[-_]?token|token|password|client[-_]?secret|secret|signature)$/i;
const active = new Map<string, TerminalTrafficRecorder>();

export interface TerminalTrafficEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string;
  complete: boolean;
  truncated: boolean;
}

export interface TerminalTrafficSnapshot {
  id: string;
  accountId: string;
  startedAt: string;
  endedAt: string | null;
  entries: TerminalTrafficEntry[];
  truncated: boolean;
  droppedEntries: number;
}

export interface TerminalTrafficRecorder {
  id: string;
  url: string;
  snapshot(): TerminalTrafficSnapshot;
  stop(): Promise<void>;
}

interface RecorderOptions {
  accountId: string;
  proxyUrl?: string | null;
  secrets?: string[];
  root?: string;
  apiBase?: string;
  bodyLimit?: number;
  sessionLimit?: number;
  entryLimit?: number;
  fetch?: typeof globalThis.fetch;
}

function storageRoot(): string {
  return resolve(process.env.TERMINAL_TRAFFIC_DIR ?? join(dirname(process.env.DB_PATH ?? "./data/cc-lb.db"), "terminal-traffic"));
}

function forwardHeaders(input: Headers, response = false): Headers {
  const headers = new Headers(input);
  for (const name of input.get("connection")?.split(",") ?? []) headers.delete(name.trim());
  for (const name of HOP_HEADERS) headers.delete(name);
  // Bun's fetch transparently decodes compressed upstream responses.
  if (response) headers.delete("content-encoding");
  return headers;
}

/** A per-terminal reverse recorder. It captures API-base traffic, not OAuth on other hosts. */
export function startTerminalTraffic(options: RecorderOptions): TerminalTrafficRecorder {
  const root = options.root ?? storageRoot();
  const bodyLimit = options.bodyLimit ?? BODY_LIMIT;
  const sessionLimit = options.sessionLimit ?? SESSION_LIMIT;
  const entryLimit = options.entryLimit ?? ENTRY_LIMIT;
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const base = (options.apiBase ?? API_BASE).replace(/\/+$/, "");
  const secrets = new Set((options.secrets ?? []).filter(Boolean));
  for (const value of [base, options.proxyUrl].filter((value): value is string => Boolean(value))) {
    const url = new URL(value);
    let username = url.username;
    let password = url.password;
    try { username = decodeURIComponent(username); password = decodeURIComponent(password); } catch { /* Preserve literal malformed percent escapes. */ }
    for (const value of [url.username, url.password, username, password]) if (value) {
      secrets.add(value);
    }
    if (username || password) secrets.add(Buffer.from(`${username}:${password}`).toString("base64"));
  }
  const state: TerminalTrafficSnapshot = {
    id: randomUUID(), accountId: options.accountId, startedAt: new Date().toISOString(), endedAt: null,
    entries: [], truncated: false, droppedEntries: 0,
  };
  const abort = new AbortController();
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const tasks = new Set<Promise<unknown>>();
  let usedBytes = 0;
  let recordingFull = false;
  let saveTimer: Timer | undefined;
  let stopping: Promise<void> | undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, `${state.id}.json`);

  function redact(text: string, partial = false): string {
    for (const secret of secrets) {
      text = text.replaceAll(secret, REDACTED);
      // A stream can stop halfway through an echoed credential between polls.
      if (partial) for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
        if (text.endsWith(secret.slice(0, n))) { text = text.slice(0, -n) + REDACTED; break; }
      }
    }
    text = text.replace(/sk-ant-[a-z0-9]+-[A-Za-z0-9_-]+/g, REDACTED);
    // Also cover credential fields in JSON/SSE, including an unfinished JSON string.
    return text.replace(/("(?:authorization|proxy[-_]?authorization|(?:x[-_])?api[-_]?key|cookie|set[-_]?cookie|(?:access|refresh|id|auth)[-_]?token|token|password|client[-_]?secret|secret)"\s*:\s*")(?:\\.|[^"\\])*("|$)/gi, `$1${REDACTED}$2`);
  }

  function cleanHeaders(headers: Headers): Record<string, string> {
    for (const [name, value] of headers) if (SECRET_NAME.test(name)) {
      if (value) secrets.add(value);
      if (/authorization/i.test(name)) {
        const credential = value.replace(/^\S+\s+/, "");
        if (credential) secrets.add(credential);
      }
      if (/cookie/i.test(name)) for (const part of value.split(";")) {
        const at = part.indexOf("=");
        if (at !== -1 && part.slice(at + 1).trim()) secrets.add(part.slice(at + 1).trim());
      }
    }
    return Object.fromEntries([...headers].map(([name, value]) => [name, SECRET_NAME.test(name) ? REDACTED : redact(value)]));
  }

  function cleanUrl(value: string): string {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    // Setting one key removes duplicates; inspect the original values before mutating.
    const parameters = [...url.searchParams];
    for (const [name, value] of parameters) if (SECRET_NAME.test(name)) {
      if (value) secrets.add(value);
      url.searchParams.set(name, REDACTED);
    }
    return redact(url.toString());
  }

  function snapshot(): TerminalTrafficSnapshot {
    return { ...state, entries: state.entries.map(entry => ({
      ...entry, url: redact(entry.url),
      requestHeaders: Object.fromEntries(Object.entries(entry.requestHeaders).map(([name, value]) => [name, redact(value)])),
      responseHeaders: Object.fromEntries(Object.entries(entry.responseHeaders).map(([name, value]) => [name, redact(value)])),
      requestBody: redact(entry.requestBody, !entry.complete), responseBody: redact(entry.responseBody, !entry.complete),
    })) };
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    // Raw credential values stay in process memory; only the redacted snapshot reaches disk.
    writeFileSync(`${file}.tmp`, JSON.stringify(snapshot()), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  function changed() {
    if (!saveTimer && !state.endedAt) saveTimer = setTimeout(() => {
      try { persist(); } catch { state.truncated = true; }
    }, 250);
  }

  function markTruncated(entry: TerminalTrafficEntry) {
    entry.truncated = true;
    state.truncated = true;
  }

  function track<T>(task: Promise<T>): Promise<T> {
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
    return task;
  }

  async function capture(body: ReadableStream<Uint8Array> | null, entry: TerminalTrafficEntry, field: "requestBody" | "responseBody"): Promise<boolean> {
    if (!body) return true;
    const reader = body.getReader();
    readers.add(reader);
    // An unsupported binary/compressed body must not masquerade as a replayable UTF-8 capture.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      while (!abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) { entry[field] += decoder.decode(); return true; }
        const take = Math.max(0, Math.min(value.byteLength, bodyLimit - bytes, sessionLimit - usedBytes));
        bytes += take;
        usedBytes += take;
        entry[field] += decoder.decode(value.subarray(0, take), { stream: true });
        changed();
        if (take < value.byteLength) {
          markTruncated(entry);
          // Awaiting cancellation of one tee waits for the still-running client branch.
          void reader.cancel().catch(() => {});
          return false;
        }
      }
      return false;
    } catch {
      // Stop the inspection tee after a decoding/read failure; the client keeps streaming.
      void reader.cancel().catch(() => {});
      return false;
    } finally {
      readers.delete(reader);
      reader.releaseLock();
      changed();
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const target = `${base}${url.pathname}${url.search}`;
      const withinLimits = !recordingFull && state.entries.length < entryLimit && usedBytes < sessionLimit;
      const requestHeaders = withinLimits ? cleanHeaders(request.headers) : {};
      const entry: TerminalTrafficEntry = {
        id: randomUUID(), timestamp: new Date().toISOString(), method: request.method,
        url: withinLimits ? cleanUrl(target) : "", requestHeaders, requestBody: "", responseStatus: null,
        responseHeaders: {}, responseBody: "", complete: false, truncated: false,
      };
      const headBytes = Buffer.byteLength(JSON.stringify(entry));
      const recording = withinLimits && usedBytes + headBytes <= sessionLimit;
      if (recording) { state.entries.push(entry); usedBytes += headBytes; changed(); }
      else {
        recordingFull = true;
        state.droppedEntries++;
        state.truncated = true;
        const last = state.entries.at(-1);
        if (last) markTruncated(last);
        changed();
      }
      let body = request.body;
      let requestCapture = Promise.resolve(true);
      if (body && recording) {
        const [forward, inspection] = body.tee();
        body = forward;
        requestCapture = track(capture(inspection, entry, "requestBody"));
      }
      try {
        const response = await fetchUpstream(target, {
          method: request.method, headers: forwardHeaders(request.headers), body,
          redirect: "manual", signal: AbortSignal.any([request.signal, abort.signal]),
          ...proxyFetchInit(options.proxyUrl),
        });
        const headers = forwardHeaders(response.headers, true);
        if (!recording) return new Response(response.body, { status: response.status, headers });
        entry.responseStatus = response.status;
        entry.responseHeaders = cleanHeaders(headers);
        usedBytes += Buffer.byteLength(JSON.stringify(entry.responseHeaders));
        if (usedBytes > sessionLimit) { entry.responseHeaders = {}; markTruncated(entry); }
        changed();
        let responseBody = response.body;
        let responseCapture = Promise.resolve(true);
        if (responseBody) {
          const [client, inspection] = responseBody.tee();
          responseBody = client;
          responseCapture = track(capture(inspection, entry, "responseBody"));
        }
        void track(Promise.all([requestCapture, responseCapture]).then(([requestDone, responseDone]) => {
          entry.complete = requestDone && responseDone && !entry.truncated && !abort.signal.aborted;
          changed();
        }));
        return new Response(responseBody, { status: response.status, statusText: response.statusText, headers });
      } catch {
        // Transport errors can contain proxy URLs and credentials; do not expose them.
        return Response.json({ error: "upstream_request_failed" }, { status: 502 });
      }
    },
  });
  const recorder: TerminalTrafficRecorder = {
    id: state.id,
    url: `http://127.0.0.1:${server.port}`,
    snapshot,
    stop() {
      return stopping ??= (async () => {
        abort.abort();
        await server.stop(true);
        for (const reader of readers) void reader.cancel().catch(() => {});
        await Promise.allSettled(tasks);
        state.endedAt = new Date().toISOString();
        active.delete(state.id);
        persist();
      })();
    },
  };
  try { persist(); } catch (error) { void server.stop(true); throw error; }
  active.set(state.id, recorder);
  return recorder;
}

/** Dashboard-authenticated snapshots remain downloadable after the terminal exits. */
export function handleTerminalTraffic(req: Request): Response | null {
  const url = new URL(req.url);
  const match = /^\/api\/accounts\/([a-zA-Z0-9-]{1,100})\/terminal\/traffic\/([a-f0-9-]{36})(\/download)?$/.exec(url.pathname);
  const accountId = match?.[1];
  const captureId = match?.[2];
  if (!match || !accountId || !captureId) return null;
  if (!isDashboardAuthenticated(req)) return unauthorizedApiResponse();
  if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  if (!getAccount(accountId)) return Response.json({ error: "account_not_found" }, { status: 404 });
  let snapshot: TerminalTrafficSnapshot;
  try {
    const recorder = active.get(captureId);
    if (recorder) snapshot = recorder.snapshot();
    else {
      const file = join(storageRoot(), `${captureId}.json`);
      if (statSync(file).size > SESSION_LIMIT * 4) throw new Error("Invalid capture size");
      snapshot = JSON.parse(readFileSync(file, "utf8"));
    }
    if (snapshot.id !== captureId || snapshot.accountId !== accountId || !Array.isArray(snapshot.entries)) throw new Error("Capture mismatch");
  } catch {
    return Response.json({ error: "capture_not_found" }, { status: 404 });
  }
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (!match[3]) return Response.json(snapshot, { headers });
  return new Response(snapshot.entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", {
    headers: { ...headers, "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="claude-session-${captureId}.jsonl"` },
  });
}

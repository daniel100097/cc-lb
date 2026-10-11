import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const temp = mkdtempSync(join(tmpdir(), "cc-lb-traffic-"));
const oldEnv = { ...process.env };
process.env.DB_PATH = join(temp, "db.sqlite");
process.env.TERMINAL_TRAFFIC_DIR = join(temp, "captures");
process.env.DASHBOARD_PASSWORD = "capture-password";
const { startTerminalTraffic, handleTerminalTraffic } = await import("./terminal-traffic");
const { createAccount } = await import("./db/accounts");
const recorders: ReturnType<typeof startTerminalTraffic>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(recorders.splice(0).map(recorder => recorder.stop()));
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
  Object.assign(process.env, oldEnv);
  rmSync(temp, { recursive: true, force: true });
});

function record(options: Parameters<typeof startTerminalTraffic>[0]) {
  const recorder = startTerminalTraffic({ root: join(temp, "captures"), ...options });
  recorders.push(recorder);
  return recorder;
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for traffic capture");
    await Bun.sleep(5);
  }
}

describe("terminal traffic recorder", () => {
  test("streams a live response before upstream finishes and preserves request path, query, and body", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let received: { url: string; body: string; auth: string | null } | undefined;
    const upstream = Bun.serve({
      port: 0, hostname: "127.0.0.1", idleTimeout: 0,
      async fetch(req) {
        received = { url: req.url, body: await req.text(), auth: req.headers.get("authorization") };
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        } }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(upstream);
    const recorder = record({ accountId: "stream-test", apiBase: `http://127.0.0.1:${upstream.port}` });
    const response = await fetch(`${recorder.url}/v1/messages?beta=true`, {
      method: "POST", headers: { authorization: "Bearer private-access", "content-type": "application/json" },
      body: '{"messages":[]}',
    });
    assert(response.body);
    const reader = response.body.getReader();
    const first = await Promise.race([reader.read(), Bun.sleep(1000).then(() => { throw new Error("SSE was buffered"); })]);
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    expect(received).toEqual({ url: `http://127.0.0.1:${upstream.port}/v1/messages?beta=true`, body: '{"messages":[]}', auth: "Bearer private-access" });
    await until(() => recorder.snapshot().entries[0]?.responseBody === "data: first\n\n");
    expect(recorder.snapshot().entries[0]?.complete).toBe(false);
    assert(stream);
    stream.enqueue(new TextEncoder().encode("data: last\n\n"));
    stream.close();
    while (!(await reader.read()).done) { /* consume forwarded stream */ }
    await until(() => recorder.snapshot().entries[0]?.complete === true);
    expect(recorder.snapshot().entries[0]?.responseBody).toBe("data: first\n\ndata: last\n\n");
  });

  test("never reuses an upstream connection, so recorded accounts cannot share one", async () => {
    const seen: { auth: string | null; port: number | undefined }[] = [];
    const upstream = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req, server) {
        // Read the body like the real API; an unread body makes Bun close the socket and hide reuse.
        await req.text();
        seen.push({ auth: req.headers.get("authorization"), port: server.requestIP(req)?.port });
        return Response.json({});
      },
    });
    servers.push(upstream);
    const apiBase = `http://127.0.0.1:${upstream.port}`;
    const first = record({ accountId: "pool-a", apiBase });
    const second = record({ accountId: "pool-b", apiBase });
    for (const [recorder, auth] of [[first, "Bearer a"], [second, "Bearer b"], [first, "Bearer a"]] as const) {
      await (await fetch(`${recorder.url}/v1/messages`, { method: "POST", headers: { authorization: auth }, body: "{}" })).text();
    }
    expect(seen.map(entry => entry.auth)).toEqual(["Bearer a", "Bearer b", "Bearer a"]);
    expect(new Set(seen.map(entry => entry.port)).size).toBe(3);
  });

  test("honors the account proxy, strips transport headers, and redacts credentials on disk and in snapshots", async () => {
    let sent: BunFetchRequestInit | undefined;
    const fakeFetch: typeof globalThis.fetch = Object.assign(async (_url: RequestInfo | URL, init?: BunFetchRequestInit) => {
      sent = init;
      expect(await new Response(init?.body).text()).toContain("access-secret");
      return new Response('data: {"text":"access-secret cookie-secret proxy-p%40ss proxy-p@ss second-query-secret", "refresh_token":"another-secret"}\n\n', {
        headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "set-cookie": "sid=response-cookie", connection: "x-private", "x-private": "omit" },
      });
    }, { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "redaction-test", proxyUrl: "http://proxy-user:proxy-p%40ss@proxy.test:8080", fetch: fakeFetch });
    const response = await fetch(`${recorder.url}/v1/messages?api_key=query-secret&api_key=second-query-secret`, {
      method: "POST", headers: {
        authorization: "Bearer access-secret", "x-api-key": "key-secret", cookie: "sid=cookie-secret",
        "content-type": "application/json", connection: "x-private", "x-private": "omit",
      }, body: '{"text":"access-secret", "password":"body-secret"}',
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-private")).toBeNull();
    expect(response.headers.get("set-cookie")).toBe("sid=response-cookie");
    expect(await response.text()).toContain("access-secret");
    expect(sent?.proxy).toBe("http://proxy-user:proxy-p%40ss@proxy.test:8080");
    const headers = new Headers(sent?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-secret");
    expect(headers.get("x-private")).toBeNull();
    expect(headers.get("host")).toBeNull();
    await until(() => recorder.snapshot().entries[0]?.complete === true);
    await recorder.stop();
    const data = JSON.stringify(recorder.snapshot()) + readFileSync(join(temp, "captures", `${recorder.id}.json`), "utf8");
    for (const secret of ["access-secret", "key-secret", "cookie-secret", "query-secret", "second-query-secret", "body-secret", "response-cookie", "proxy-user", "proxy-p%40ss", "proxy-p@ss", "another-secret"]) expect(data).not.toContain(secret);
    expect(data).toContain("[redacted]");
  });

  test("bounds captured bodies without truncating forwarded responses and finishes an open stream on stop", async () => {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({ start(value) {
      controller = value;
      value.enqueue(encoder.encode("abcdefghij"));
    } }), { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "bounded-test", bodyLimit: 5, fetch: fakeFetch });
    const response = await fetch(`${recorder.url}/v1/messages`);
    assert(response.body);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("abcdefghij");
    await until(() => recorder.snapshot().truncated);
    expect(recorder.snapshot().entries[0]?.responseBody).toBe("abcde");
    expect(recorder.snapshot().entries[0]?.truncated).toBe(true);
    assert(controller);
    controller.enqueue(encoder.encode("more"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("more");
    await Promise.race([recorder.stop(), Bun.sleep(1000).then(() => { throw new Error("Capture shutdown hung"); })]);
    expect(recorder.snapshot().endedAt).not.toBeNull();
    expect(recorder.snapshot().entries[0]?.complete).toBe(false);
  });

  test("bounds session entries while still forwarding later requests", async () => {
    let forwarded = 0;
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => { forwarded++; return Response.json({ ok: true }); }, { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "entry-limit-test", entryLimit: 1, fetch: fakeFetch });
    await (await fetch(`${recorder.url}/v1/messages`)).text();
    await (await fetch(`${recorder.url}/v1/messages`)).text();
    expect(forwarded).toBe(2);
    expect(recorder.snapshot().entries).toHaveLength(1);
    expect(recorder.snapshot().droppedEntries).toBe(1);
    expect(recorder.snapshot().entries[0]?.truncated).toBe(true);
  });

  test("shutdown cancels a response capture that is still waiting for another chunk", async () => {
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
    } })), { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "pending-capture", fetch: fakeFetch });
    const response = await fetch(`${recorder.url}/v1/messages`);
    assert(response.body);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await until(() => recorder.snapshot().entries[0]?.responseBody === "first");
    await Promise.race([recorder.stop(), Bun.sleep(1000).then(() => { throw new Error("Pending capture did not stop"); })]);
    expect(recorder.snapshot().endedAt).not.toBeNull();
    expect(recorder.snapshot().entries[0]?.complete).toBe(false);
    expect(recorder.snapshot().entries[0]?.truncated).toBe(false);
  });

  test("stops admitting captures once headers exceed the remaining session budget", async () => {
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => Response.json({ ok: true }), { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "header-limit", sessionLimit: 600, fetch: fakeFetch });
    expect((await fetch(`${recorder.url}/v1/messages`, { headers: { "x-large": "x".repeat(1000) } })).status).toBe(200);
    expect((await fetch(`${recorder.url}/v1/messages`)).status).toBe(200);
    expect(recorder.snapshot().entries).toHaveLength(0);
    expect(recorder.snapshot().droppedEntries).toBe(2);
  });

  test("forwards binary bytes unchanged but does not mark lossy text as a complete capture", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x01]);
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => new Response(bytes), { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "binary-capture", fetch: fakeFetch });
    const response = await fetch(`${recorder.url}/v1/messages`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await Bun.sleep(0);
    const entry = recorder.snapshot().entries[0];
    expect(entry?.responseStatus).toBe(200);
    expect(entry?.complete).toBe(false);
    expect(entry?.responseBody).not.toContain("\uFFFD");
  });

  test("enforces the session byte budget and hides credentials split across live stream chunks", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode("echo: secret-acce"));
    } }), { headers: { "content-type": "text/event-stream" } }), { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: "session-byte-limit", bodyLimit: 10_000, sessionLimit: 700, secrets: ["secret-access-token"], fetch: fakeFetch });
    const response = await fetch(`${recorder.url}/v1/messages`);
    const finished = response.text();
    await until(() => recorder.snapshot().entries[0]?.responseBody.startsWith("echo:") === true);
    expect(recorder.snapshot().entries[0]?.responseBody).toBe("echo: [redacted]");
    assert(stream);
    stream.enqueue(new TextEncoder().encode("ss-token " + "x".repeat(1000)));
    stream.close();
    expect(await finished).toContain("secret-access-token");
    await until(() => recorder.snapshot().entries[0]?.truncated === true);
    const snapshot = recorder.snapshot();
    expect(snapshot.truncated).toBe(true);
    expect(Buffer.byteLength(snapshot.entries[0]?.responseBody ?? "")).toBeLessThan(700);
    expect(JSON.stringify(snapshot)).not.toContain("secret-access-token");
  });

  test("protects snapshots and downloads, validates account ownership, and serves finished captures from disk", async () => {
    const owner = createAccount({ name: "Capture owner" });
    const other = createAccount({ name: "Other account" });
    const fakeFetch: typeof globalThis.fetch = Object.assign(async () => Response.json({ ok: true }), { preconnect: globalThis.fetch.preconnect });
    const recorder = record({ accountId: owner.id, fetch: fakeFetch });
    await (await fetch(`${recorder.url}/v1/messages`)).text();
    await until(() => recorder.snapshot().entries[0]?.complete === true);
    const endpoint = `http://dashboard.test/api/accounts/${owner.id}/terminal/traffic/${recorder.id}`;
    const headers = { authorization: "Bearer capture-password" };
    expect(handleTerminalTraffic(new Request(endpoint))?.status).toBe(401);
    expect(handleTerminalTraffic(new Request(`${endpoint}/download`))?.status).toBe(401);
    expect(handleTerminalTraffic(new Request(endpoint.replace(owner.id, other.id), { headers }))?.status).toBe(404);
    expect(handleTerminalTraffic(new Request(endpoint, { headers, method: "POST" }))?.status).toBe(405);
    const live = handleTerminalTraffic(new Request(endpoint, { headers }));
    assert(live);
    expect((await live.json()).endedAt).toBeNull();
    await recorder.stop();
    const finished = await handleTerminalTraffic(new Request(endpoint, { headers }))?.json();
    expect(finished.endedAt).not.toBeNull();
    const download = handleTerminalTraffic(new Request(`${endpoint}/download`, { headers }));
    assert(download);
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("cache-control")).toBe("no-store");
    const exchange = JSON.parse((await download.text()).trim());
    expect(exchange.responseStatus).toBe(200);
    expect(exchange.complete).toBe(true);
    expect(exchange.truncated).toBe(false);
    expect(exchange.requestHeaders).not.toHaveProperty("authorization");
  });
});

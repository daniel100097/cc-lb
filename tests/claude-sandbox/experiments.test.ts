import { expect, test } from "bun:test";
import { createExperiment, parseReplay } from "./experiments";
import { createFakeApi, type Exchange } from "./server";
import { FAKE_ACCESS_TOKEN } from "./fixtures";
import { mutateCapture, writeComparison, writeReplayComparison } from "./compare";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exchange: Exchange = {
  timestamp: "2026-01-01T00:00:00Z",
  method: "POST",
  url: "https://api.anthropic.com/v1/messages?beta=true",
  requestHeaders: {},
  requestBody: '{"stream":false}',
  responseStatus: 200,
  responseHeaders: { "content-type": "application/json" },
  responseBody: '{"answer":"original"}',
};

test("capture replay filters other endpoints, preserves order and fails closed when exhausted", async () => {
  const recorded = [
    { ...exchange, method: "GET", url: "https://api.anthropic.com/api/oauth/profile" },
    { ...exchange, responseStatus: 429, responseBody: "retry" },
    { ...exchange, responseBody: "finished" },
  ].map(value => JSON.stringify(value)).join("\n");
  const experiment = createExperiment({ replay: parseReplay(recorded) });
  expect((await experiment.transformResponse(exchange)).responseStatus).toBe(429);
  expect((await experiment.transformResponse(exchange)).responseBody).toBe("finished");
  await expect(experiment.transformResponse(exchange)).rejects.toThrow("Replay exhausted after 2 responses");
  await experiment.stop();
  expect(() => parseReplay('{"responseStatus":600,"responseHeaders":{},"responseBody":""}')).toThrow("responseStatus");
  expect(() => parseReplay("[]")).toThrow("no POST /v1/messages");
  expect(() => parseReplay(JSON.stringify({ ...exchange, truncated: true }))).toThrow("truncated or incomplete");
  expect(() => parseReplay(JSON.stringify({ ...exchange, complete: false }))).toThrow("truncated or incomplete");
});

test("interactive replies keep stable IDs and preserve pending requests after malformed submissions", async () => {
  const experiment = createExperiment({ interactive: true, port: 0 });
  const first = experiment.transformResponse(exchange);
  const second = experiment.transformResponse({ ...exchange, requestBody: "second request" });
  const getPending = async () => (await fetch(`${experiment.controlUrl}/pending`)).json();
  const reply = (body: unknown) => fetch(`${experiment.controlUrl}/reply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const pending = await getPending();
    expect(pending.id).toBe("1");
    expect((await reply({ ...pending, id: "999" })).status).toBe(409);
    expect((await fetch(`${experiment.controlUrl}/reply`, { method: "POST", body: "{broken" })).status).toBe(400);
    expect((await reply({ ...pending, responseStatus: 600 })).status).toBe(400);
    expect((await reply({ ...pending, responseHeaders: { "bad header": "invalid" } })).status).toBe(400);
    expect((await getPending()).id).toBe(pending.id);
    expect((await reply({ ...pending, responseBody: "edited" })).status).toBe(200);
    expect((await first).responseBody).toBe("edited");
    const next = await getPending();
    expect(next.id).toBe("2");
    expect(next.requestBody).toBe("second request");
    expect((await reply(next)).status).toBe(200);
    await second;
    expect(await getPending()).toBeNull();
    expect((await reply(pending)).status).toBe(409);
  } finally {
    // Ensure no rejected promises survive if an assertion fails before a reply.
    void first.catch(() => {});
    void second.catch(() => {});
    await experiment.stop();
  }
});

test("fake API captures actual edited responses, isolates controls to messages and records replay exhaustion", async () => {
  const experiment = createExperiment({ replay: [{ responseStatus: 204, responseHeaders: { "x-edited": "yes" }, responseBody: "" }] });
  const fake = createFakeApi({ transformResponse: experiment.transformResponse });
  const request = (path: string) => new Request(`https://api.anthropic.com${path}`, {
    method: "POST", headers: { authorization: `Bearer ${FAKE_ACCESS_TOKEN}` }, body: "{}",
  });
  expect((await fake.fetch(request("/v1/messages/count_tokens"))).status).toBe(200);
  const edited = await fake.fetch(request("/v1/messages"));
  expect(edited.status).toBe(204);
  expect(await edited.text()).toBe("");
  expect(fake.traffic[1]?.responseHeaders["x-edited"]).toBe("yes");
  const exhausted = await fake.fetch(request("/v1/messages"));
  expect(exhausted.status).toBe(502);
  expect(exhausted.headers.get("x-should-retry")).toBe("false");
  expect(fake.traffic[2]?.responseBody).toContain("Replay exhausted");
  await experiment.stop();
});

test("mutation rebuilds split Read arguments and preserves later recorded replies", () => {
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const responseBody = [
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read-1", name: "Read", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/work/' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'fixture.txt","limit":2}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ].map(event).join("");
  const captured = [{ ...exchange, responseBody, responseHeaders: { "content-type": "text/event-stream", "content-length": "999" } }, exchange];
  const mutated = parseReplay(mutateCapture(captured.map(value => JSON.stringify(value)).join("\n")));
  const chunks = mutated[0]?.responseBody.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).filter(value => value.type === "content_block_delta");
  const input = JSON.parse(chunks?.map(value => value.delta.partial_json).join("") ?? "{}");
  expect(input).toEqual({ file_path: "/tmp/work/alternate.txt", limit: 2 });
  expect(mutated[0]?.responseHeaders["content-length"]).toBeUndefined();
  expect(mutated[1]?.responseBody).toBe(exchange.responseBody);
  expect(() => mutateCapture(JSON.stringify(exchange))).toThrow("no complete streamed Read");
});

test("comparison normalizes only listed identities and reports exact changed follow-up tool results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cc-lb-comparison-"));
  const paths = { live: join(directory, "live"), replay: join(directory, "replay"), mutated: join(directory, "mutated") };
  try {
    for (const [name, path] of Object.entries(paths)) {
      const output = join(path, "direct-text");
      await mkdir(output, { recursive: true });
      const metadata = { user_id: JSON.stringify({ device_id: name, session_id: name, account_uuid: "unchanged" }) };
      const messages = [{ role: "assistant", content: [{ type: "tool_use", id: name, name: "Read", input: { file_path: "/workspace/fixture.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: name, content: name === "mutated" ? "ALTERNATE_CONTENT" : "ORIGINAL_CONTENT" }] }];
      const captures = [[], messages].map(history => ({ ...exchange,
        requestHeaders: { authorization: `Bearer secret-${name}`, "x-claude-code-session-id": name },
        requestBody: JSON.stringify({ model: "test-model", metadata, messages: history }),
      }));
      await writeFile(join(output, "client.jsonl"), captures.map(value => JSON.stringify(value)).join("\n"));
      await writeFile(join(output, "cli.stdout.jsonl"), JSON.stringify({ type: "result", result: "BASELINE_OK", is_error: false }));
    }
    await writeComparison(paths, directory);
    const source = await readFile(join(directory, "comparison.json"), "utf8");
    const report = JSON.parse(source);
    expect(report.comparisons.liveToReplay.sameAfterNormalization).toBe(true);
    expect(report.comparisons.liveToMutated.differences).toEqual([{
      path: "$[1].body.messages[1].content[0].content", live: "ORIGINAL_CONTENT", candidate: "ALTERNATE_CONTENT",
    }]);
    expect(report.live.stableSession).toBe(true);
    expect(source).not.toContain("secret-");
    expect(await readFile(join(directory, "comparison.md"), "utf8")).toContain("ALTERNATE_CONTENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("downloaded captures compare with replay and distinguish API text from original terminal output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cc-lb-downloaded-replay-"));
  const captured = { ...exchange, complete: true, truncated: false,
    requestBody: '{"model":"recorded-model","messages":[]}',
    responseBody: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"RECORDED_ANSWER"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  };
  try {
    for (const name of ["direct-text", "cc-lb-text"]) {
      const output = join(directory, name);
      await mkdir(output);
      await writeFile(join(output, "client.jsonl"), JSON.stringify({ ...captured, requestBody: '{"model":"replay-model","messages":[]}' }));
      await writeFile(join(output, "cli.stdout.jsonl"), JSON.stringify({ type: "result", result: "REPLAY_OUTPUT", is_error: false }));
    }
    await writeReplayComparison(JSON.stringify(captured), directory, directory);
    const report = JSON.parse(await readFile(join(directory, "comparison.json"), "utf8"));
    expect(report.kind).toBe("recorded-versus-offline-replay");
    expect(report.recorded.finalOutput).toBe("RECORDED_ANSWER");
    expect(report.recorded.finalOutputSource).toContain("original CLI output unavailable");
    expect(report.replays["direct-text"].finalOutput).toBe("REPLAY_OUTPUT");
    expect(report.comparisons["cc-lb-text"].differences).toEqual([{
      path: "$[0].body.model", recorded: "recorded-model", replay: "replay-model",
    }]);
    expect(await readFile(join(directory, "comparison.md"), "utf8")).toContain("workspace are not restored");

    await writeReplayComparison(JSON.stringify(parseReplay(JSON.stringify(captured))), directory, directory);
    const fixturesOnly = JSON.parse(await readFile(join(directory, "comparison.json"), "utf8"));
    expect(fixturesOnly.comparisons["direct-text"].sameAfterNormalization).toBeNull();
    expect(fixturesOnly.interpretation).toContain("Request equivalence cannot be assessed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

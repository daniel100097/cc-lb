import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parseReplay } from "./experiments";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(source: string): unknown { return JSON.parse(source); }
function jsonLines(source: string): unknown[] { return source.split("\n").filter(line => line.trim()).map(parseJson); }

/** Change the first recorded Read argument; all later assistant replies remain recorded. */
export function mutateCapture(source: string): string {
  const fixtures = parseReplay(source);
  for (const fixture of fixtures) {
    const frames = fixture.responseBody.split(/\r?\n\r?\n/).map(raw => {
      const data = raw.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      const value = data && data !== "[DONE]" ? parseJson(data) : undefined;
      return { raw, value, changed: false };
    });
    for (const [startIndex, start] of frames.entries()) {
      if (!isRecord(start.value) || start.value.type !== "content_block_start") continue;
      const block = start.value.content_block;
      if (!isRecord(block) || block.type !== "tool_use" || block.name !== "Read") continue;
      const chunks: { frame: (typeof frames)[number]; delta: Record<string, unknown> }[] = [];
      let stopped = false;
      for (const frame of frames.slice(startIndex + 1)) {
        if (!isRecord(frame.value) || frame.value.index !== start.value.index) continue;
        if (frame.value.type === "content_block_stop") { stopped = true; break; }
        const delta = frame.value.delta;
        if (isRecord(delta) && delta.type === "input_json_delta" && typeof delta.partial_json === "string") chunks.push({ frame, delta });
      }
      if (!stopped) throw new Error("Cannot mutate incomplete Read SSE block: missing content_block_stop");
      const input = chunks.length ? parseJson(chunks.map(chunk => chunk.delta.partial_json).join("")) : block.input;
      if (!isRecord(input) || typeof input.file_path !== "string") throw new Error("Recorded Read tool call has no string file_path");
      const alternate = posix.join(posix.dirname(input.file_path), "alternate.txt");
      if (alternate === input.file_path) throw new Error("Recorded Read already targets alternate.txt; no mutation to compare");
      input.file_path = alternate;
      if (chunks.length) {
        for (const [index, chunk] of chunks.entries()) {
          chunk.delta.partial_json = index === 0 ? JSON.stringify(input) : "";
          chunk.frame.changed = true;
        }
      } else {
        block.input = input;
        start.changed = true;
      }
      fixture.responseBody = frames.map(frame => {
        if (!frame.changed) return frame.raw;
        const lines = frame.raw.split(/\r?\n/).filter(line => !line.startsWith("data:"));
        return [...lines, `data: ${JSON.stringify(frame.value)}`].join("\n");
      }).join("\n\n");
      // HTTP length must describe the modified stream, not the recorded original bytes.
      for (const key of Object.keys(fixture.responseHeaders)) if (key.toLowerCase() === "content-length") delete fixture.responseHeaders[key];
      return `${JSON.stringify(fixtures, null, 2)}\n`;
    }
  }
  throw new Error("Cannot compare a tool mutation: live capture contains no complete streamed Read tool call");
}

const normalizationRules = [
  "Diff scope: request method, URL path/query, headers and parsed body; capture timestamps, URL origins and response fields remain in raw captures outside the request diff",
  "Request headers x-claude-code-session-id and x-client-request-id: replace dynamic IDs",
  "Request headers authorization, proxy-authorization, x-api-key and cookie: redact credential values, preserve authentication presence/scheme",
  "Request body metadata.user_id: replace session_id and device_id inside JSON; preserve all other fields",
  "Legacy metadata.user_id user_<device>_account_<account>_session_<session>: replace device and session only",
  "Request body tool_use.id, tool_result.tool_use_id and message.id: map IDs by first occurrence within each run, preserving references",
];

function normalizer() {
  const ids = new Map<string, string>();
  const id = (value: unknown) => {
    if (typeof value !== "string") return value;
    if (!ids.has(value)) ids.set(value, `<id:${ids.size + 1}>`);
    return ids.get(value);
  };
  function body(value: unknown, path = ""): unknown {
    if (Array.isArray(value)) return value.map(item => body(item, `${path}[]`));
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      const childPath = path ? `${path}.${key}` : key;
      if (childPath === "metadata.user_id" && typeof entry === "string") {
        try {
          const user = parseJson(entry);
          if (isRecord(user)) return [key, JSON.stringify({ ...user,
            ...(typeof user.device_id === "string" ? { device_id: "<device>" } : {}),
            ...(typeof user.session_id === "string" ? { session_id: "<session>" } : {}),
          })];
        } catch { /* Older CLI versions use the structured string below. */ }
        return [key, entry.replace(/^user_[a-f0-9]+_account_([^_]+)_session_[a-f0-9-]+$/, "user_<device>_account_$1_session_<session>")];
      }
      if ((key === "id" && ["tool_use", "message"].includes(String(value.type))) ||
          (key === "tool_use_id" && value.type === "tool_result")) return [key, id(entry)];
      return [key, body(entry, childPath)];
    }));
  }
  return (request: Record<string, unknown>) => {
    const headers = isRecord(request.requestHeaders) ? request.requestHeaders : {};
    const safeHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => {
      const key = name.toLowerCase();
      if (["authorization", "proxy-authorization"].includes(key)) {
        const scheme = /^(Bearer|Basic|Digest)\s+/i.exec(String(value))?.[1];
        return [key, scheme ? `${scheme} <redacted>` : "<redacted>"];
      }
      if (["x-api-key", "cookie"].includes(key)) return [key, "<redacted>"];
      if (["x-claude-code-session-id", "x-client-request-id"].includes(key)) return [key, "<dynamic-id>"];
      return [key, value];
    }));
    const url = new URL(String(request.url));
    return { method: request.method, path: `${url.pathname}${url.search}`,
      headers: safeHeaders, body: body(parseJson(String(request.requestBody))) };
  };
}

interface Difference { path: string; live: unknown; candidate: unknown }
function differences(live: unknown, candidate: unknown, path = "$", result: Difference[] = []): Difference[] {
  if (Object.is(live, candidate)) return result;
  if (Array.isArray(live) && Array.isArray(candidate)) {
    for (let index = 0; index < Math.max(live.length, candidate.length); index++) differences(live[index], candidate[index], `${path}[${index}]`, result);
  } else if (isRecord(live) && isRecord(candidate)) {
    for (const key of new Set([...Object.keys(live), ...Object.keys(candidate)])) differences(live[key], candidate[key], `${path}.${key}`, result);
  } else result.push({ path, live: live === undefined ? "<missing>" : live, candidate: candidate === undefined ? "<missing>" : candidate });
  return result;
}

function summarizeCapture(captures: unknown[], final: unknown, finalOutputSource: string) {
  const requests = captures.filter((value): value is Record<string, unknown> =>
    isRecord(value) && value.method === "POST" && new URL(String(value.url)).pathname === "/v1/messages",
  );
  const normalize = normalizer();
  const normalized = requests.map(normalize);
  const bodies = requests.map(value => parseJson(String(value.requestBody)));
  const sessions = requests.map(value => isRecord(value.requestHeaders) ? value.requestHeaders["x-claude-code-session-id"] : undefined);
  const history = bodies.map((value, index) => ({ request: index + 1, blocks: isRecord(value) && Array.isArray(value.messages)
    ? value.messages.flatMap(message => isRecord(message) && Array.isArray(message.content)
      ? message.content.filter(block => isRecord(block) && ["tool_use", "tool_result"].includes(String(block.type))) : []) : [],
  }));
  const first = bodies[0];
  return {
    normalized,
    summary: {
      totalRequestCount: captures.length,
      requestCount: requests.length,
      models: [...new Set(bodies.map(value => isRecord(value) ? value.model : null))],
      authentication: [...new Set(requests.map(value => {
        const headers = isRecord(value.requestHeaders) ? value.requestHeaders : {};
        if (headers["x-api-key"]) return "API-key header";
        if (!headers.authorization) return "none";
        return typeof headers.authorization === "string" && /^Bearer\s/i.test(headers.authorization)
          ? "Bearer header" : "Authorization header (scheme unavailable)";
      }))],
      stableSession: sessions.length > 0 && sessions.every(value => typeof value === "string" && value.length > 0) && new Set(sessions).size === 1,
      firstRequestShape: isRecord(first) ? {
        fields: Object.keys(first).sort(),
        messageRoles: Array.isArray(first.messages) ? first.messages.map(message => isRecord(message) ? message.role : null) : [],
        tools: Array.isArray(first.tools) ? first.tools.map(tool => isRecord(tool) ? tool.name : null) : [],
      } : null,
      toolHistory: history,
      finalOutput: isRecord(final) ? final.result : null,
      finalOutputSource,
      isError: isRecord(final) ? final.is_error : null,
    },
  };
}

async function readRun(directory: string, caseName = "direct-text") {
  const path = join(directory, caseName);
  const [captureSource, output] = await Promise.all([
    readFile(join(path, "client.jsonl"), "utf8"), readFile(join(path, "cli.stdout.jsonl"), "utf8"),
  ]);
  const final = jsonLines(output).findLast(value => isRecord(value) && value.type === "result");
  return summarizeCapture(jsonLines(captureSource), final, final ? "CLI result" : "CLI result unavailable");
}

async function saveReport(outputDir: string, report: { interpretation: string },
  summaries: Record<string, ReturnType<typeof summarizeCapture>["summary"]>,
  comparisons: { label: string; differences: Difference[] }[],
) {
  const rows = Object.entries(summaries).map(([name, run]) => `| ${[
    name, run.requestCount, run.models.join(", "), run.authentication.join(", "), run.stableSession,
    JSON.stringify(run.finalOutput), run.finalOutputSource,
  ].map(value => String(value).replaceAll("|", "\\|").replace(/\r?\n/g, " ")).join(" | ")} |`);
  const markdown = [
    "# Claude Code traffic comparison", "", report.interpretation, "",
    "| Run | Messages requests | Model | Authentication | Stable session | Final output | Output source |",
    "| --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
    ...comparisons.flatMap(({ label, differences: diffs }) => [
      `${label}: ${diffs.length} differences after the listed normalization.`, "",
      ...diffs.slice(0, 30).map(diff => `- \`${diff.path}\``),
      ...(diffs.length > 30 ? ["- Further differences are included in comparison.json."] : []), "",
    ]),
    "## Tool history (exact captured contents)", "",
    "```json", JSON.stringify(Object.fromEntries(Object.entries(summaries).map(([name, run]) => [name, run.toolHistory])), null, 2), "```", "",
    "## Normalization", "", ...normalizationRules.map(rule => `- ${rule}`), "",
    "Full changed values are in comparison.json. Raw client.jsonl and upstream.jsonl captures are retained in each run directory.", "",
  ].join("\n");
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(join(outputDir, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`),
    writeFile(join(outputDir, "comparison.md"), markdown),
  ]);
}

/** Compare client-facing requests; raw captures remain the source of truth. */
export async function writeComparison(paths: { live: string; replay: string; mutated: string }, outputDir: string): Promise<void> {
  const [live, replay, mutated] = await Promise.all([readRun(paths.live), readRun(paths.replay), readRun(paths.mutated)]);
  const replayDifferences = differences(live.normalized, replay.normalized);
  const mutatedDifferences = differences(live.normalized, mutated.normalized);
  const report = {
    normalizationRules,
    sources: paths,
    live: live.summary, replay: replay.summary, mutated: mutated.summary,
    comparisons: {
      liveToReplay: { sameAfterNormalization: !replayDifferences.length, differences: replayDifferences },
      liveToMutated: { sameAfterNormalization: !mutatedDifferences.length, differences: mutatedDifferences },
    },
    interpretation: "The live baseline forwards inference requests to the configured real API endpoint. All three CLI sessions use synthetic seeded OAuth credentials and a fake profile; real OAuth login or validation is not tested. Authentication labels describe observed headers, not token provenance. Replay and mutation reuse recorded assistant replies. Changed tool results prove a change in CLI requests; they do not measure how the live model would answer that changed input. System prompts and environment text are compared verbatim.",
  };
  await saveReport(outputDir, report, { live: live.summary, replay: replay.summary, mutated: mutated.summary }, [
    { label: "Live → replay", differences: replayDifferences }, { label: "Live → mutated", differences: mutatedDifferences },
  ]);
}

/** Compare a downloaded recording with each completed offline replay case. */
export async function writeReplayComparison(captureSource: string, replayDir: string, outputDir: string): Promise<void> {
  const fixtures = parseReplay(captureSource);
  let captures: unknown[];
  try { const parsed = parseJson(captureSource); captures = Array.isArray(parsed) ? parsed : [parsed]; }
  catch { captures = jsonLines(captureSource); }
  let recordedText: string | null = null;
  const response = fixtures.at(-1)?.responseBody ?? "";
  try {
    if (response.trimStart().startsWith("{")) {
      const message = parseJson(response);
      if (isRecord(message) && Array.isArray(message.content)) {
        recordedText = message.content.filter(isRecord).filter(block => block.type === "text").map(block => block.text).join("") || null;
      }
    } else {
      recordedText = response.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim())
        .filter(line => line !== "[DONE]").map(parseJson).filter(isRecord)
        .filter(event => isRecord(event.delta) && event.delta.type === "text_delta")
        .map(event => isRecord(event.delta) ? event.delta.text : "").join("") || null;
    }
  } catch { /* Captures without complete assistant text have no known terminal output. */ }
  const recorded = summarizeCapture(captures, { result: recordedText, is_error: null },
    recordedText === null ? "Unavailable: recording has no final assistant text or CLI output" : "Recorded API text; original CLI output unavailable");
  const cases = (await readdir(replayDir, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^(direct|cc-lb)-/.test(entry.name));
  if (!cases.length) throw new Error(`No replay cases found in ${replayDir}`);
  const replays = await Promise.all(cases.map(async entry => ({ name: entry.name, run: await readRun(replayDir, entry.name) })));
  const compared = replays.map(({ name, run }) => ({ name, differences: differences(recorded.normalized, run.normalized) }));
  const unavailable = recorded.summary.requestCount === 0;
  const interpretation = unavailable
    ? "This file contains responses without original requests. Request equivalence cannot be assessed; the report shows offline replay behavior only."
    : "Recorded traffic is compared with fresh offline CLI requests in capture order. Only the listed identity and credential fields are normalized; prompt, tool, workspace, account and system differences remain visible.";
  const report = {
    kind: "recorded-versus-offline-replay", normalizationRules,
    recorded: recorded.summary, replays: Object.fromEntries(replays.map(({ name, run }) => [name, run.summary])),
    comparisons: Object.fromEntries(compared.map(({ name, differences: diffs }) => [name, {
      sameAfterNormalization: unavailable ? null : !diffs.length,
      unavailableReason: unavailable ? "The input contains no original /v1/messages requests" : null,
      differences: unavailable ? [] : diffs.map(diff => ({ path: diff.path, recorded: diff.live, replay: diff.candidate })),
    }])),
    interpretation: `${interpretation} Authentication labels describe observed headers, not token provenance; the offline replay uses synthetic seeded OAuth credentials and a fake profile. The original terminal output is unavailable; any recorded answer is extracted from the last API response. Original files, tools, settings and workspace are not restored. Replayed responses are delivered sequentially to a fresh scratch session, so this does not reconstruct an interactive conversation or measure a live model's response to changed inputs.`,
  };
  await saveReport(outputDir, report,
    { recorded: recorded.summary, ...Object.fromEntries(replays.map(({ name, run }) => [name, run.summary])) },
    unavailable ? [] : compared.map(({ name, differences: diffs }) => ({ label: `Recorded → ${name}`, differences: diffs })),
  );
}

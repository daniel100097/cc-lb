import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { parseReplay } from "../tests/claude-sandbox/experiments";
import type { Exchange } from "../tests/claude-sandbox/server";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  help: { type: "boolean" }, scenario: { type: "string" }, route: { type: "string" },
  text: { type: "string" }, prompt: { type: "string" }, replay: { type: "string" },
  interactive: { type: "boolean" }, live: { type: "boolean" }, compare: { type: "boolean" },
  output: { type: "string" }, "no-build": { type: "boolean" },
} });
if (values.help) {
  console.log(`Usage: bun run test:claude [options]

  (no options)         Run the ten offline regression cases
  --scenario NAME      text, tool, refresh, unauthorized, rate-limit, overload, truncated-stream
  --route ROUTE        direct, cc-lb, both
  --text TEXT          Change the scripted final answer
  --replay FILE        Replay messages responses from a downloaded/captured JSONL or JSON file
  --interactive        Pause messages replies for editing through docker exec
  --live               Forward paused messages to the configured Anthropic endpoint
  --compare            Capture live traffic, replay it, mutate a tool call, and write a comparison
  --prompt TEXT        Override the scratch-workspace prompt
  --output DIRECTORY   Save captures and results here
  --no-build           Reuse the existing test image

Live mode uses host ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY.
Credentials stay on the host; the container itself has no external network.
Default artifacts: data/claude-sandbox/<run>/`);
  process.exit(0);
}
if (values.live && values.replay) throw new Error("Choose --live or --replay, not both");
const project = resolve(import.meta.dir, "..");
const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const output = values.output ? resolve(values.output) : resolve(project, "data/claude-sandbox", id);
const container = `cc-lb-sandbox-${id.toLowerCase()}`;
const image = "cc-lb-claude-sandbox:local";
mkdirSync(output, { recursive: true });

async function docker(command: string[], options: { archive?: string; input?: string } = {}): Promise<number> {
  const child = Bun.spawn(["docker", ...command], {
    cwd: project, stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: options.archive ? Bun.file(options.archive) : "inherit", stderr: "inherit",
  });
  if (options.input !== undefined && typeof child.stdin !== "number" && child.stdin) {
    await child.stdin.write(options.input);
    await child.stdin.end();
  }
  return child.exited;
}
async function cleanup() {
  const child = Bun.spawn(["docker", "rm", "--force", container], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void cleanup().finally(() => process.exit(130)); });
}
async function control(action: "pending" | "reply", reply?: unknown): Promise<(Exchange & { id: string }) | null> {
  const child = Bun.spawn(["docker", "exec", "-i", container, "bun", "tests/claude-sandbox/control.ts", action], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  if (reply !== undefined) await child.stdin.write(JSON.stringify(reply));
  await child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) {
    if (action === "reply") throw new Error(`Control reply failed: ${stderr || stdout}`);
    return null;
  }
  return JSON.parse(stdout);
}
async function forwardLive(exchange: Exchange & { id: string }) {
  const source = new URL(exchange.url);
  if (exchange.method !== "POST" || source.pathname !== "/v1/messages") throw new Error("Live forwarding only permits POST /v1/messages");
  const base = new URL(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid live API base URL");
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!token && !apiKey) throw new Error("Live comparison requires ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY on the host");
  const headers = new Headers(exchange.requestHeaders);
  for (const name of ["host", "content-length", "connection", "accept-encoding", "authorization", "x-api-key"]) headers.delete(name);
  if (token) headers.set("authorization", `Bearer ${token}`);
  else if (apiKey) headers.set("x-api-key", apiKey);
  const target = `${base.toString().replace(/\/+$/, "")}${source.pathname}${source.search}`;
  const response = await fetch(target, {
    method: "POST", headers, body: exchange.requestBody,
    redirect: "error", signal: AbortSignal.timeout(90_000),
  });
  const responseHeaders = new Headers(response.headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "set-cookie"]) responseHeaders.delete(name);
  const responseBody = await response.text();
  const reply = { id: exchange.id, responseStatus: response.status, responseHeaders: Object.fromEntries(responseHeaders), responseBody };
  const recordedHeaders = new Headers(headers);
  for (const name of ["authorization", "x-api-key", "cookie", "proxy-authorization"]) {
    if (recordedHeaders.has(name)) recordedHeaders.set(name, "<redacted>");
  }
  appendFileSync(resolve(output, "live-upstream.jsonl"), `${JSON.stringify({ ...exchange, ...reply, url: target, requestHeaders: Object.fromEntries(recordedHeaders) })}\n`);
  console.log(`Live response ${response.status} (${responseBody.length} characters)`);
  if (!await control("reply", reply)) throw new Error("Could not deliver the live response to the sandbox");
}
if (!values["no-build"]) {
  const built = await docker(["build", "--file", "tests/claude-sandbox/Dockerfile", "--tag", image, "."]);
  if (built !== 0) process.exit(built);
}
if (values.compare) {
  const { mutateCapture, writeComparison } = await import("../tests/claude-sandbox/compare");
  const prompt = "Use the Read tool to read fixture.txt. Then reply with exactly BASELINE_OK. Do not use any other tools.";
  for (const mode of ["live", "replay", "mutated"] as const) {
    const replayFile = resolve(output, mode === "mutated" ? "mutated-responses.json" : "live/direct-text/client.jsonl");
    if (mode === "mutated") await Bun.write(replayFile, mutateCapture(await Bun.file(resolve(output, "live/direct-text/client.jsonl")).text()));
    const child = Bun.spawn(["bun", import.meta.path, "--no-build", "--scenario", "text", "--route", "direct",
      "--output", resolve(output, mode), "--prompt", prompt,
      ...(mode === "live" ? ["--live"] : ["--replay", replayFile]),
    ], { cwd: project, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error(`${mode} comparison run failed; inspect ${resolve(output, mode)}`);
  }
  await writeComparison({ live: resolve(output, "live"), replay: resolve(output, "replay"), mutated: resolve(output, "mutated") }, output);
  console.log(`Comparison: ${resolve(output, "comparison.md")}`);
  process.exit(0);
}
const experiment = !!(values.replay || values.interactive || values.live);
const interactive = !!(values.interactive || values.live);
const replay = values.replay ? parseReplay(await Bun.file(resolve(values.replay)).text()) : null;
const hosts = ["api.anthropic.com", "platform.claude.com", "claude.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com", "one.one.one.one"];
const caseArgs = ["--scenario", values.scenario ?? (experiment ? "text" : "all"), "--route", values.route ?? (experiment ? "direct" : "both")];
if (values.text !== undefined) caseArgs.push("--text", values.text);
if (values.prompt !== undefined) caseArgs.push("--prompt", values.prompt);
if (experiment) caseArgs.push("--experiment");
if (interactive) caseArgs.push("--interactive");
if (values.interactive && !values.live) {
  console.log(`Inspect: docker exec ${container} bun tests/claude-sandbox/control.ts pending > reply.json`);
  console.log(`Reply:   docker exec -i ${container} bun tests/claude-sandbox/control.ts reply < reply.json`);
}
let status = 1;
let stopped = false;
let forwardingError: unknown;
let worker: Promise<void> | undefined;
try {
  const running = docker([
    "run", "--rm", "--interactive", "--name", container,
    "--network", "none", "--dns", "127.0.0.1",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--sysctl", "net.ipv4.ip_unprivileged_port_start=0",
    "--pids-limit", "128", "--memory", "2g", "--cpus", "2",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs", "/home/bun:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=700",
    ...hosts.flatMap(host => ["--add-host", `${host}:127.0.0.1`]),
    image, ...caseArgs,
  ], { archive: resolve(output, "artifacts.tar.gz"), input: experiment ? JSON.stringify(replay) : undefined });
  if (values.live) worker = (async () => {
    while (!stopped) {
      const pending = await control("pending");
      if (pending) {
        try { await forwardLive(pending); }
        catch (error) {
          forwardingError = error;
          if (!await control("reply", {
            id: pending.id, responseStatus: 502,
            responseHeaders: { "content-type": "application/json", "x-should-retry": "false" },
            responseBody: JSON.stringify({ type: "error", error: { type: "api_error", message: "Host live forwarding failed; inspect the host error." } }),
          })) throw error;
        }
      }
      if (!stopped) await Bun.sleep(300);
    }
  })().catch(async error => { forwardingError = error; await cleanup(); });
  status = await running;
  stopped = true;
  await worker;
  const unpack = Bun.spawn(["tar", "-xzf", resolve(output, "artifacts.tar.gz"), "-C", output], { stdout: "inherit", stderr: "inherit" });
  if (await unpack.exited !== 0) status = 1;
} finally {
  stopped = true;
  await cleanup();
}
console.log(`Artifacts: ${output}`);
if (values.replay) {
  const { writeReplayComparison } = await import("../tests/claude-sandbox/compare");
  await writeReplayComparison(await Bun.file(resolve(values.replay)).text(), output, output);
  console.log(`Replay comparison: ${resolve(output, "comparison.md")}`);
}
if (forwardingError) throw forwardingError;
process.exit(status);

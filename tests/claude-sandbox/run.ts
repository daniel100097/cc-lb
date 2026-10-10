import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createFakeApi, type Exchange, type Scenario } from "./server";
import { createExperiment, parseReplay } from "./experiments";
import { FAKE_ACCESS_TOKEN, FAKE_ACCOUNT_UUID, REFRESHED_ACCESS_TOKEN, seedClaudeSession } from "./fixtures";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  scenario: { type: "string", default: "all" },
  route: { type: "string", default: "both" },
  text: { type: "string", default: "SANDBOX_RESPONSE_OK" },
  case: { type: "boolean", default: false },
  experiment: { type: "boolean", default: false },
  interactive: { type: "boolean", default: false },
  prompt: { type: "string", default: "Read fixture.txt if asked, then answer briefly. This is an offline protocol test." },
} });
const scenarios: Scenario[] = ["text", "tool", "refresh", "unauthorized", "rate-limit", "overload", "truncated-stream"];
type Route = "direct" | "cc-lb";
function isScenario(value: string | undefined): value is Scenario { return scenarios.some(scenario => scenario === value); }
function isRoute(value: string | undefined): value is Route { return value === "direct" || value === "cc-lb"; }
const artifacts = "/tmp/artifacts";
const certificate = "/tmp/sandbox-cert.pem";
const key = "/tmp/sandbox-key.pem";
const cli = "/app/node_modules/.bin/claude";
const fixtureText = "SANDBOX_FILE_CONTENT_7b3e";
const poolUuid = "33333333-3333-4333-8333-333333333333";
const poolMachine = "fedcba9876543210".repeat(4);

async function execute(command: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}) {
  const child = Bun.spawn(command, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeout ?? 45_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally { clearTimeout(timer); }
}

function save(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runCase(scenario: Scenario, route: Route) {
  const name = `${route}-${scenario}`;
  const output = join(artifacts, name);
  const workspace = `/tmp/${name}/workspace`;
  const config = `/tmp/${name}/claude`;
  mkdirSync(output, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "fixture.txt"), fixtureText);
  writeFileSync(join(workspace, "alternate.txt"), "SANDBOX_ALTERNATE_CONTENT_92af");
  seedClaudeSession(config, { expired: scenario === "refresh" });
  // Force a real profile request so saved metadata alone cannot pass the test.
  const settings = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8"));
  settings.oauthAccount.profileFetchedAt = 0;
  save(join(config, ".claude.json"), settings);
  const replaySource = values.experiment ? readFileSync("/tmp/experiment.json", "utf8") : "";
  const experiment = values.experiment ? createExperiment({
    interactive: values.interactive,
    replay: replaySource.trim() === "null" ? undefined : parseReplay(replaySource),
  }) : undefined;
  const fake = createFakeApi({
    scenario, text: values.text, toolPath: join(workspace, "fixture.txt"),
    transformResponse: experiment ? exchange => experiment.transformResponse(exchange) : undefined,
    onExchange: exchange => appendFileSync(join(output, "upstream.jsonl"), `${JSON.stringify(exchange)}\n`),
  });
  const incoming: Exchange[] = [];
  const captures: Promise<void>[] = [];
  let proxy: ((request: Request, url: URL) => Promise<Response>) | undefined;
  let exportProxyLogs: (() => unknown) | undefined;
  let closeDatabase: (() => void) | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  if (route === "cc-lb") {
    process.env.DB_PATH = `/tmp/${name}/cc-lb.db`;
    process.env.CLAUDE_ACCOUNTS_DIR = `/tmp/${name}/accounts`;
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => fake.fetch(request) });
    process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${upstream.port}`;
    const { createAccount } = await import("../../src/db/accounts");
    const { patchSettings } = await import("../../src/db/settings");
    const { seedAccountCredentials } = await import("../../src/testing/seed-credentials");
    const { handleProxy } = await import("../../src/proxy/handler");
    const { listRequests } = await import("../../src/db/request-log");
    const { db } = await import("../../src/db/client");
    const account = createAccount({ name: "Synthetic sandbox account" });
    seedAccountCredentials(account.id, {
      accessToken: REFRESHED_ACCESS_TOKEN, accountUuid: poolUuid, machineId: poolMachine,
      expiresAt: Date.now() + 86_400_000,
    });
    patchSettings({ rawHttpLoggingEnabled: true });
    proxy = handleProxy;
    exportProxyLogs = () => listRequests({ limit: 100, offset: 0 });
    closeDatabase = () => db.close();
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 443, idleTimeout: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    async fetch(request) {
      const timestamp = new Date().toISOString();
      const body = await request.clone().text();
      const url = new URL(request.url);
      const response = proxy && url.hostname === "api.anthropic.com" && url.pathname.startsWith("/v1/")
        ? await proxy(request, url) : await fake.fetch(request);
      captures.push(response.clone().text().then(responseBody => {
        const exchange = {
          timestamp, method: request.method, url: request.url,
          requestHeaders: Object.fromEntries(request.headers), requestBody: body,
          responseStatus: response.status, responseHeaders: Object.fromEntries(response.headers), responseBody,
        };
        incoming.push(exchange);
        appendFileSync(join(output, "client.jsonl"), `${JSON.stringify(exchange)}\n`);
      }));
      return response;
    },
  });
  // Explicit allowlist: never inherit an API key, OAuth token, proxy, or CLI customization.
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    CLAUDE_CONFIG_DIR: config,
    NODE_EXTRA_CA_CERTS: certificate,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_MAX_RETRIES: "1",
    CLAUDE_CODE_MAX_TURNS: "4",
    CLAUDE_CODE_OVERLOADED_RETRY_BASE_DELAY_MS: "100",
    TERM: "dumb",
  };
  const checks: string[] = [];
  const check = (condition: unknown, description: string) => { assert(condition, description); checks.push(description); };
  let failure: string | undefined;
  let cliResult: Awaited<ReturnType<typeof execute>> | undefined;
  try {
    const auth = await execute([cli, "auth", "status", "--json"], { cwd: workspace, env });
    writeFileSync(join(output, "auth-status.json"), auth.stdout);
    writeFileSync(join(output, "auth-stderr.txt"), auth.stderr);
    check(!auth.timedOut && auth.exitCode === 0, "CLI auth status succeeds");
    const status = JSON.parse(auth.stdout);
    check(status.loggedIn === true && status.authMethod === "claude.ai", "CLI recognizes a Claude OAuth session");
    cliResult = await execute([
      cli, "--print", "--verbose", "--output-format", "stream-json",
      "--model", "claude-sonnet-4-6", "--no-session-persistence", "--no-chrome",
      "--permission-mode", "dontAsk", "--tools", "Read", "--allowedTools", "Read",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
      "--disable-slash-commands", "--prompt-suggestions", "false",
      "--debug-file", join(output, "cli-debug.txt"),
      values.prompt ?? "Read fixture.txt and reply briefly.",
    ], { cwd: workspace, env, timeout: values.interactive ? 650_000 : 45_000 });
    writeFileSync(join(output, "cli.stdout.jsonl"), cliResult.stdout);
    writeFileSync(join(output, "cli.stderr.txt"), cliResult.stderr);
    await Promise.all(captures);
    check(!cliResult.timedOut, "CLI finishes before the timeout");
    check(incoming.some(x => new URL(x.url).pathname === "/api/oauth/profile" && x.responseStatus === 200), "CLI fetches the fake OAuth profile");
    const messages = incoming.filter(x => new URL(x.url).pathname === "/v1/messages");
    const upstreamMessages = fake.traffic.filter(x => new URL(x.url).pathname === "/v1/messages");
    check(messages.length > 0, "Real CLI sent a messages request");
    check(messages[0]?.requestHeaders.authorization === `Bearer ${scenario === "refresh" ? REFRESHED_ACCESS_TOKEN : FAKE_ACCESS_TOKEN}`, "CLI uses the synthetic OAuth bearer");
    check(!messages[0]?.requestHeaders["x-api-key"], "CLI did not switch to API-key authentication");
    const session = messages[0]?.requestHeaders["x-claude-code-session-id"];
    check(session && messages.every(x => x.requestHeaders["x-claude-code-session-id"] === session), "Session identity remains stable across requests");
    if (route === "cc-lb" && ["unauthorized", "rate-limit"].includes(scenario)) {
      check(cliResult.exitCode !== 0, "cc-lb rejection reaches the CLI");
    } else {
      check(cliResult.exitCode === 0, "CLI completes successfully");
      const result = cliResult.stdout.trim().split("\n").map(line => JSON.parse(line)).findLast(row => row.type === "result");
      check(result?.is_error === false && (values.experiment || result?.result === values.text), values.experiment ? "CLI completes the response experiment" : "CLI displays the scripted final answer");
    }
    if (scenario === "tool") {
      const toolResults = messages.flatMap(x => JSON.parse(x.requestBody).messages)
        .filter(message => message.role === "user" && Array.isArray(message.content))
        .flatMap(message => message.content)
        .filter(block => block.type === "tool_result" && block.tool_use_id === "toolu_sandbox_read_0001");
      check(toolResults.some(block => !block.is_error && JSON.stringify(block.content).includes(fixtureText)), "Matching tool result carries the actual fixture contents without an error");
    }
    if (scenario === "refresh" || (scenario === "unauthorized" && route === "direct")) {
      check(fake.traffic.some(x => new URL(x.url).pathname === "/v1/oauth/token" && x.responseStatus === 200), "CLI exchanges the fake refresh token");
      const credentials = JSON.parse(readFileSync(join(config, ".credentials.json"), "utf8"));
      check(credentials.claudeAiOauth.accessToken === REFRESHED_ACCESS_TOKEN, "CLI persists the refreshed access token");
      check(messages.some(x => x.requestHeaders.authorization === `Bearer ${REFRESHED_ACCESS_TOKEN}`), "CLI sends the refreshed token on an API request");
    }
    if (scenario === "unauthorized" || scenario === "rate-limit" || scenario === "overload") {
      const expected = { unauthorized: 401, "rate-limit": 429, overload: 529 }[scenario];
      check(upstreamMessages.some(x => x.responseStatus === expected), `Fake upstream injected ${expected}`);
    }
    if (["rate-limit", "overload", "truncated-stream"].includes(scenario) && !(route === "cc-lb" && scenario === "rate-limit")) {
      check(upstreamMessages.length > 1, "Injected failure causes another upstream request");
    }
    if (route === "cc-lb") {
      check(upstreamMessages.length > 0 && upstreamMessages.every(x => x.requestHeaders.authorization === `Bearer ${REFRESHED_ACCESS_TOKEN}`), "cc-lb substitutes the pooled account bearer on every request");
      const clientDevices = messages.map(x => JSON.parse(JSON.parse(x.requestBody).metadata.user_id).device_id);
      check(clientDevices.every(device => typeof device === "string" && device.length > 0), "Actual CLI device identities are present");
      check(upstreamMessages.every(x => {
        const identity = JSON.parse(JSON.parse(x.requestBody).metadata.user_id);
        return identity.account_uuid === poolUuid && identity.device_id === poolMachine
          && identity.session_id === session && x.requestHeaders["x-claude-code-session-id"] === session;
      }), "cc-lb rewrites account/device identity and preserves the session on every request");
      check(upstreamMessages.every(x => !x.requestBody.includes(FAKE_ACCOUNT_UUID)
        && clientDevices.every(device => !x.requestBody.includes(device) && !JSON.stringify(x.requestHeaders).includes(device))), "Client identity does not leak in upstream bodies or headers");
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await experiment?.stop();
    await server.stop(true);
    await upstream?.stop(true);
    await Promise.allSettled(captures);
    if (exportProxyLogs) save(join(output, "cc-lb-requests.json"), exportProxyLogs());
    closeDatabase?.();
    const result = { scenario, route, passed: !failure, checks, failure, exitCode: cliResult?.exitCode, exchanges: incoming.length };
    save(join(output, "result.json"), result);
    console.error(`${failure ? "FAIL" : "PASS"} ${name}${failure ? `: ${failure}` : ` (${checks.length} checks)`}`);
  }
  return failure ? 1 : 0;
}

async function main() {
  assert(values.scenario === "all" || isScenario(values.scenario), "Unknown --scenario");
  assert(values.route === "both" || isRoute(values.route), "Unknown --route");
  assert(process.getuid?.() !== 0, "Run as the unprivileged container user");
  assert(Object.values(networkInterfaces()).flat().every(address => address?.internal), "Sandbox requires loopback-only networking");
  if (values.case) {
    assert(isScenario(values.scenario) && isRoute(values.route), "A case requires one scenario and route");
    return runCase(values.scenario, values.route);
  }
  mkdirSync(artifacts, { recursive: true });
  let failed = false;
  try {
    if (values.experiment) writeFileSync("/tmp/experiment.json", (await Bun.stdin.text()).trim() || "null");
    const hosts = ["api.anthropic.com", "platform.claude.com", "claude.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com", "one.one.one.one"];
    const cert = await execute(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", key, "-out", certificate, "-subj", "/CN=cc-lb offline sandbox",
      "-addext", `subjectAltName=${hosts.map(host => `DNS:${host}`).join(",")}`,
      "-addext", "basicConstraints=critical,CA:TRUE",
    ]);
    assert.equal(cert.exitCode, 0, cert.stderr);
    const cases = [];
    const routes: Route[] = values.route === "both" ? ["direct", "cc-lb"] : [values.route];
    for (const route of routes) {
      const selected: Scenario[] = values.scenario === "all"
        ? (route === "direct" ? scenarios : ["text", "tool", "overload"])
        : [values.scenario];
      for (const scenario of selected) {
        const result = await execute(["bun", import.meta.path, "--case", "--route", route, "--scenario", scenario, "--text", values.text ?? "SANDBOX_RESPONSE_OK",
          "--prompt", values.prompt ?? "Read fixture.txt and reply briefly.",
          ...(values.experiment ? ["--experiment"] : []), ...(values.interactive ? ["--interactive"] : []),
        ], {
          env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_EXTRA_CA_CERTS: certificate }, timeout: values.interactive ? 700_000 : 110_000,
        });
        console.error(result.stderr.trim());
        failed ||= result.exitCode !== 0 || result.timedOut;
        cases.push({ route, scenario, exitCode: result.exitCode, timedOut: result.timedOut });
      }
    }
    save(join(artifacts, "summary.json"), { passed: !failed, cases, claudeVersion: (await execute([cli, "--version"])).stdout.trim() });
  } catch (error) {
    failed = true;
    save(join(artifacts, "error.json"), { error: String(error) });
    console.error(error);
  } finally {
    const archive = Bun.spawn(["tar", "-czf", "-", "-C", artifacts, "."], { stdout: "inherit", stderr: "inherit" });
    if (await archive.exited !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

process.exit(await main());

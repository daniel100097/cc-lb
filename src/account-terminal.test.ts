import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "cc-lb-terminal-"));
const originalEnv = { ...process.env };
process.env.DB_PATH = join(tempDir, "db.sqlite");
process.env.CLAUDE_ACCOUNTS_DIR = join(tempDir, "accounts");
const { createAccount, getAccount, updateAccount } = await import("./db/accounts");
const { seedAccountCredentials } = await import("./testing/seed-credentials");
const { accountConfigDir, accountWorkspaceDir } = await import("./anthropic/account-config");
const { probeAccount } = await import("./anthropic/account-probe");
const { accountTerminalWebSocket, upgradeAccountTerminal, stopAccountTerminal } = await import("./account-terminal");
const { appRouter } = await import("./api/router");

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  websocket: accountTerminalWebSocket,
  fetch: upgradeAccountTerminal,
});
const origin = `http://127.0.0.1:${server.port}`;
const accounts: string[] = [];
const sockets: WebSocket[] = [];

beforeEach(() => {
  process.env.CLAUDE_ACCOUNTS_DIR = join(tempDir, "accounts");
  process.env.DASHBOARD_PASSWORD = "terminal-test-password";
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const id of accounts.splice(0)) await stopAccountTerminal(id);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

afterAll(async () => {
  await server.stop(true);
  rmSync(tempDir, { recursive: true, force: true });
});

function account(proxyUrl: string | null = null) {
  const created = createAccount({ name: "Terminal test", proxy_url: proxyUrl });
  accounts.push(created.id);
  return created;
}

function headers(extra: Record<string, string> = {}) {
  return { authorization: "Bearer terminal-test-password", origin, ...extra };
}

async function connect(id: string) {
  // Reflect preserves Bun's header options when lib.dom supplies the global constructor type.
  const socket: WebSocket = Reflect.construct(WebSocket, [
    `${origin.replace("http:", "ws:")}/api/accounts/${id}/terminal`, { headers: headers() },
  ]);
  sockets.push(socket);
  const messages: Array<{ type: string; data?: string; code?: number }> = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await until(() => messages.some((message) => message.type === "ready"));
  return { socket, messages, output: () => messages.map((message) => message.data ?? "").join("") };
}

async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for terminal");
    await Bun.sleep(10);
  }
}

async function handshake(id: string, extra: Record<string, string> = {}) {
  return fetch(`${origin}/api/accounts/${id}/terminal`, {
    headers: headers({ upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...extra }),
  });
}

describe("account terminal", () => {
  test("requires dashboard auth, same-origin upgrades, existing accounts, and gives read-only connection errors", async () => {
    const a = account();
    expect((await handshake(a.id, { authorization: "" })).status).toBe(401);
    expect((await handshake(a.id, { origin: "" })).status).toBe(403);
    expect((await handshake(a.id, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await handshake(a.id, { origin: "null" })).status).toBe(403);
    expect((await handshake("unknown-account")).status).toBe(404);
    const diagnostic = await fetch(`${origin}/api/accounts/${a.id}/terminal`, { headers: { authorization: "Bearer terminal-test-password" } });
    expect(diagnostic.status).toBe(426);
    expect((await diagnostic.json()).message).toContain("WebSockets");
  });

  test("runs a real PTY in the account workspace, isolates auth/proxy env, forwards input and resizes", async () => {
    const a = account("http://127.0.0.1:7777/");
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    process.env.ANTHROPIC_AUTH_TOKEN = "must-not-leak";
    process.env.ANTHROPIC_BASE_URL = "https://wrong.example";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "must-not-leak";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.NO_PROXY = "*";
    process.env.ALL_PROXY = "http://wrong.example";
    process.env.CLAUDE_CODE_LOGIN_COMMAND = `stty -echo; printf 'CONFIG=%s\\nCWD=%s\\nPROXY=%s\\nISOLATED=%s%s%s%s%s%s%s\\n' "$CLAUDE_CONFIG_DIR" "$PWD" "$HTTPS_PROXY" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_BASE_URL" "$CLAUDE_CODE_OAUTH_TOKEN" "$CLAUDE_CODE_USE_BEDROCK" "$NO_PROXY" "$ALL_PROXY"; while IFS= read -r line; do stty size; printf 'INPUT=%s\\n' "$line"; done`;
    const terminal = await connect(a.id);
    await until(() => terminal.output().includes("ISOLATED="));
    expect(terminal.output()).toContain(`CONFIG=${accountConfigDir(a.id)}`);
    expect(terminal.output()).toContain(`CWD=${accountWorkspaceDir(a.id)}`);
    expect(terminal.output()).toContain("PROXY=http://127.0.0.1:7777/");
    expect(terminal.output()).toContain("ISOLATED=\r\n");
    terminal.socket.send(JSON.stringify({ type: "resize", cols: 123, rows: 37 }));
    terminal.socket.send(JSON.stringify({ type: "input", data: "hello 世界\r" }));
    await until(() => terminal.output().includes("INPUT=hello 世界"));
    expect(terminal.output()).toContain("37 123");
    expect((await handshake(a.id)).status).toBe(409);
    await expect(probeAccount(a.id, "manual")).rejects.toThrow("Close the account terminal");
  });

  test("clears reauth only after credentials actually change to a valid token, including on CLI exit", async () => {
    const a = account();
    seedAccountCredentials(a.id, { accessToken: "stale", expiresAt: Date.now() + 3_600_000 });
    updateAccount(a.id, { needs_reauth: 1 });
    const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "new", refreshToken: "new-refresh", expiresAt: Date.now() + 3_600_000 } });
    process.env.CLAUDE_CODE_LOGIN_COMMAND = `stty -echo; read line; printf '%s' '${credentials}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; exit 7`;
    const terminal = await connect(a.id);
    await Bun.sleep(1100);
    expect(getAccount(a.id)?.needs_reauth).toBe(1);
    terminal.socket.send(JSON.stringify({ type: "input", data: "login\r" }));
    await until(() => terminal.messages.some((message) => message.type === "exit"));
    expect(terminal.messages.find((message) => message.type === "exit")?.code).toBe(7);
    expect(getAccount(a.id)?.needs_reauth).toBe(0);
  });

  test("invalid input ends the process and releases the account for a new terminal", async () => {
    const a = account();
    process.env.CLAUDE_CODE_LOGIN_COMMAND = "sleep 60";
    const terminal = await connect(a.id);
    terminal.socket.send(JSON.stringify({ type: "resize", cols: 100000, rows: 24 }));
    await until(() => terminal.socket.readyState === WebSocket.CLOSED);
    await stopAccountTerminal(a.id);
    const replacement = await connect(a.id);
    expect(replacement.messages.some((message) => message.type === "ready")).toBe(true);
  });

  test("closing the terminal kills the CLI and its children, even when SIGTERM is ignored", async () => {
    const a = account();
    process.env.CLAUDE_CODE_LOGIN_COMMAND = `trap '' TERM; sleep 60 & printf '%s %s' "$$" "$!" > "$CLAUDE_CONFIG_DIR/pids"; wait`;
    const terminal = await connect(a.id);
    const pidFile = join(accountConfigDir(a.id), "pids");
    await until(() => { try { return readFileSync(pidFile, "utf8").includes(" "); } catch { return false; } });
    const pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
    terminal.socket.close();
    await stopAccountTerminal(a.id);
    for (const pid of pids) {
      await until(() => {
        try {
          // A reparented zombie is already dead; the host init owns its reaping.
          return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false;
        } catch { return true; }
      });
    }
  });

  test("account deletion and proxy changes stop the running CLI before changing persistent state", async () => {
    const a = account();
    process.env.CLAUDE_CODE_LOGIN_COMMAND = "sleep 60";
    const first = await connect(a.id);
    const caller = appRouter.createCaller({ req: new Request(origin) });
    await caller.accounts.update({ id: a.id, proxyUrl: "http://127.0.0.1:7778" });
    await until(() => first.socket.readyState === WebSocket.CLOSED);
    expect(getAccount(a.id)?.proxy_url).toBe("http://127.0.0.1:7778/");
    const second = await connect(a.id);
    await caller.accounts.delete({ id: a.id });
    await until(() => second.socket.readyState === WebSocket.CLOSED);
    expect(getAccount(a.id)).toBeNull();
  });

  test("server SIGTERM kills terminal children that ignore shutdown signals", async () => {
    const pidFile = join(tempDir, "shutdown-pids");
    const childServer = Bun.spawn([process.execPath, "-e", `
      import { accountTerminalWebSocket, upgradeAccountTerminal } from ${JSON.stringify(new URL("./account-terminal.ts", import.meta.url).pathname)};
      import { createAccount } from ${JSON.stringify(new URL("./db/accounts.ts", import.meta.url).pathname)};
      const account = createAccount({name: "shutdown"});
      const server = Bun.serve({port: 0, hostname: "127.0.0.1", websocket: accountTerminalWebSocket, fetch: upgradeAccountTerminal});
      console.log(JSON.stringify({id: account.id, port: server.port}));
    `], {
      env: {
        ...process.env,
        DB_PATH: join(tempDir, "shutdown.sqlite"),
        CLAUDE_CODE_LOGIN_COMMAND: `trap '' TERM HUP; sleep 60 & printf '%s %s' "$$" "$!" > '${pidFile}'; wait`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const { value } = await childServer.stdout.getReader().read();
      const address = JSON.parse(new TextDecoder().decode(value));
      const childOrigin = `http://127.0.0.1:${address.port}`;
      const socket: WebSocket = Reflect.construct(WebSocket, [
        `${childOrigin.replace("http:", "ws:")}/api/accounts/${address.id}/terminal`, { headers: headers({ origin: childOrigin }) },
      ]);
      sockets.push(socket);
      await until(() => { try { return readFileSync(pidFile, "utf8").includes(" "); } catch { return false; } });
      const pids = readFileSync(pidFile, "utf8").split(" ").map(Number);
      childServer.kill("SIGTERM");
      expect(await childServer.exited).toBe(143);
      for (const pid of pids) {
        await until(() => {
          try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z") ?? false; }
          catch { return true; }
        });
      }
    } finally {
      childServer.kill("SIGKILL");
      await childServer.exited;
    }
  });
});

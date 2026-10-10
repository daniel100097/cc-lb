import type { Server, ServerWebSocket, Subprocess, WebSocketHandler } from "bun";
import { isDashboardAuthenticated, unauthorizedApiResponse } from "./auth";
import {
  accountConfigDir,
  accountWorkspaceDir,
  ensureAccountWorkspace,
  readCredentialsFile,
  type FileCredentials,
} from "./anthropic/account-config";
import { accountCliBusy, releaseAccountTerminal, reserveAccountTerminal } from "./anthropic/account-probe";
import { buildClaudeCliEnv } from "./anthropic/tmux-driver";
import { getAccount, updateAccount } from "./db/accounts";
import { startTerminalTraffic, type TerminalTrafficRecorder } from "./terminal-traffic";

export interface AccountTerminal {
  accountId: string;
  proxyUrl: string | null;
  credentials: FileCredentials | null;
  request: Request;
  recordTraffic?: boolean;
  traffic?: TerminalTrafficRecorder;
  socket?: ServerWebSocket<AccountTerminal>;
  process?: Subprocess;
  checkTimer?: Timer;
  killTimer?: Timer;
  finished?: Promise<void>;
  stopping?: boolean;
}

const terminals = new Map<string, AccountTerminal>();
const MAX_INPUT_BYTES = 16 * 1024;

/** Only the authenticated dashboard listener calls this upgrade handler. */
export function upgradeAccountTerminal(req: Request, server: Server<AccountTerminal>): Response | undefined {
  if (!isDashboardAuthenticated(req)) return unauthorizedApiResponse();
  const url = new URL(req.url);
  const match = /^\/api\/accounts\/([a-zA-Z0-9-]{1,100})\/terminal$/.exec(url.pathname);
  const account = match?.[1] ? getAccount(match[1]) : null;
  const upgrading = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  // A browser cannot read a rejected WebSocket handshake. This read-only GET
  // gives it an actionable error without requiring a second endpoint.
  if (!upgrading && req.method === "GET") {
    if (!account) return Response.json({ error: "account_not_found", message: "Account not found." }, { status: 404 });
    if (accountCliBusy(account.id)) return busyResponse();
    return Response.json({ error: "websocket_required", message: "Could not connect to the terminal. Check that your connection supports WebSockets, then retry." }, { status: 426 });
  }
  const origin = req.headers.get("origin");
  try {
    const parsedOrigin = new URL(origin ?? "");
    if (!/^https?:$/.test(parsedOrigin.protocol) || parsedOrigin.host !== url.host || parsedOrigin.origin !== origin) {
      throw new Error("Invalid origin");
    }
  } catch {
    return Response.json({ error: "forbidden_origin" }, { status: 403 });
  }
  if (!account) return Response.json({ error: "account_not_found" }, { status: 404 });
  if (req.method !== "GET" || !upgrading) {
    return Response.json({ error: "websocket_required" }, { status: 426 });
  }
  if (!reserveAccountTerminal(account.id)) {
    return busyResponse();
  }
  const session: AccountTerminal = {
    accountId: account.id,
    proxyUrl: account.proxy_url,
    credentials: readCredentialsFile(account.id),
    request: req,
    recordTraffic: url.searchParams.get("record") === "1",
  };
  terminals.set(account.id, session);
  session.checkTimer = setTimeout(() => {
    if (!session.process) void stopAccountTerminal(account.id);
  }, 5000);
  if (server.upgrade(req, { data: session })) return;
  release(session);
  return Response.json({ error: "websocket_upgrade_failed" }, { status: 400 });
}

export const accountTerminalWebSocket: WebSocketHandler<AccountTerminal> = {
  maxPayloadLength: MAX_INPUT_BYTES * 2,
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: true,
  idleTimeout: 120,
  sendPings: true,
  open(socket) {
    const session = socket.data;
    session.socket = socket;
    clearTimeout(session.checkTimer);
    try {
      if (session.stopping || !getAccount(session.accountId)) throw new Error("Account is no longer available.");
      ensureAccountWorkspace(session.accountId);
      const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)/.test(key)
        && !/^(https?|all|no)_proxy$/i.test(key),
      ));
      const env = buildClaudeCliEnv(baseEnv, accountConfigDir(session.accountId), session.proxyUrl);
      if (session.recordTraffic) {
        session.traffic = startTerminalTraffic({
          accountId: session.accountId, proxyUrl: session.proxyUrl,
          secrets: [session.credentials?.accessToken, session.credentials?.refreshToken].filter((value): value is string => Boolean(value)),
        });
        env.ANTHROPIC_BASE_URL = session.traffic.url;
        // OAuth keeps the account's egress proxy; local API recording must not leave through it.
        env.NO_PROXY = "127.0.0.1,localhost";
        env.no_proxy = env.NO_PROXY;
      }
      const command = env.CLAUDE_CODE_LOGIN_COMMAND;
      if (!command) throw new Error("Claude command is missing");
      const decoder = new TextDecoder();
      const child = Bun.spawn(["/bin/sh", "-c", command], {
        cwd: accountWorkspaceDir(session.accountId),
        env,
        terminal: {
          cols: 100,
          rows: 30,
          name: "xterm-256color",
          data(_terminal, data) {
            const text = decoder.decode(data, { stream: true });
            if (text) send(session, { type: "output", data: text });
          },
        },
      });
      session.process = child;
      session.finished = child.exited.then(async (code) => {
        const tail = decoder.decode();
        if (tail) send(session, { type: "output", data: tail });
        syncCredentials(session);
        // Bun's PTY child is a session/process-group leader. Reap any shell children too.
        signalGroup(child, "SIGKILL");
        child.terminal?.close();
        await session.traffic?.stop().catch(() => {
          send(session, { type: "error", message: "Could not finish saving the traffic capture." });
        });
        release(session);
        send(session, { type: "exit", code });
        socket.close(1000, "Claude exited");
      });
      session.checkTimer = setInterval(() => {
        const account = getAccount(session.accountId);
        if (!account || account.proxy_url !== session.proxyUrl || !isDashboardAuthenticated(session.request)) {
          send(session, { type: "error", message: "The account or dashboard access changed. Reopen the terminal." });
          void stopAccountTerminal(session.accountId);
          return;
        }
        syncCredentials(session);
      }, 1000);
      send(session, { type: "ready", ...(session.traffic ? { captureId: session.traffic.id } : {}) });
    } catch {
      send(session, { type: "error", message: "Could not start Claude Code. Check the server's Claude installation." });
      release(session);
      socket.close(1011, "Could not start Claude");
    }
  },
  message(socket, message) {
    const session = socket.data;
    if (session.stopping || !session.process?.terminal) return;
    try {
      if (typeof message !== "string") throw new Error("Text messages required");
      const value = JSON.parse(message);
      if (value?.type === "input" && typeof value.data === "string" && Buffer.byteLength(value.data) <= MAX_INPUT_BYTES) {
        session.process.terminal.write(value.data);
      } else if (value?.type === "resize" && validDimension(value.cols, 500) && validDimension(value.rows, 200)) {
        session.process.terminal.resize(value.cols, value.rows);
      } else {
        throw new Error("Invalid terminal message");
      }
    } catch {
      send(session, { type: "error", message: "Invalid terminal message." });
      socket.close(1008, "Invalid terminal message");
      void stopAccountTerminal(session.accountId);
    }
  },
  close(socket) {
    if (terminals.get(socket.data.accountId) === socket.data) void stopAccountTerminal(socket.data.accountId);
  },
};

function busyResponse(): Response {
  return Response.json({ error: "account_busy", message: "An account terminal or usage probe is already running. Try again shortly." }, { status: 409 });
}

function validDimension(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function send(session: AccountTerminal, message: object): void {
  if (session.socket?.readyState === 1) session.socket.send(JSON.stringify(message));
}

function syncCredentials(session: AccountTerminal): void {
  const credentials = readCredentialsFile(session.accountId);
  // An existing, rejected token must never clear needs_reauth merely by opening the terminal.
  if (credentials && (credentials.expiresAt ?? 0) > Date.now()
      && (credentials.accessToken !== session.credentials?.accessToken || credentials.refreshToken !== session.credentials?.refreshToken)) {
    updateAccount(session.accountId, { needs_reauth: 0 });
    session.credentials = credentials;
  }
}

function signalGroup(child: Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode === null) child.kill(signal);
  }
}

function release(session: AccountTerminal): void {
  clearInterval(session.checkTimer);
  clearTimeout(session.killTimer);
  void session.traffic?.stop().catch(() => {});
  if (terminals.get(session.accountId) === session) {
    terminals.delete(session.accountId);
    releaseAccountTerminal(session.accountId);
  }
}

/** Await this before changing the account's proxy or removing its credential directory. */
export async function stopAccountTerminal(accountId: string): Promise<void> {
  const session = terminals.get(accountId);
  if (!session || session.stopping) return session?.finished;
  session.stopping = true;
  session.socket?.close(1000, "Terminal closed");
  const child = session.process;
  if (!child) {
    await session.traffic?.stop().catch(() => {});
    release(session);
    return;
  }
  signalGroup(child, "SIGTERM");
  session.killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), 1000);
  await session.finished;
}

// Also release PTYs when the Bun process exits (including watch-mode restarts).
process.on("exit", () => {
  for (const session of terminals.values()) {
    if (session.process) signalGroup(session.process, "SIGKILL");
  }
});
// Bun's default signal exit does not emit the exit event.
process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));

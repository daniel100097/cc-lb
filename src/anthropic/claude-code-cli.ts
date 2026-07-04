import { randomUUID } from "node:crypto";
import { findClaudeCodeOAuthToken } from "./credentials";

const LOGIN_URL_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 80_000;
const ESC = 27;
const BEL = 7;

type LoginStatus = "starting" | "waiting_for_code" | "waiting_for_token" | "complete" | "failed";

interface Waiter {
  check: (output: string) => boolean;
  reject: (error: Error) => void;
  timeout: Timer;
}

interface LoginSession {
  id: string;
  tmuxName: string;
  createdAt: number;
  output: string;
  status: LoginStatus;
  authUrl: string | null;
  exited: boolean;
  exitCode: number | null;
  waiters: Waiter[];
  pollTimer: Timer | null;
  refreshing: boolean;
}

const sessions = new Map<string, LoginSession>();

export interface ClaudeCodeLoginBeginResult {
  sessionId: string;
  authUrl: string;
}

export interface ClaudeCodeLoginCompleteResult {
  token: string;
}

export interface ClaudeCodeLoginStatusResult {
  status: LoginStatus;
  authUrl: string | null;
  output: string;
  exited: boolean;
  exitCode: number | null;
  tokenReady: boolean;
}

export async function beginClaudeCodeLogin(now = Date.now()): Promise<ClaudeCodeLoginBeginResult> {
  cleanupExpiredSessions(now);

  const id = randomUUID();
  const tmuxName = tmuxSessionName(id);
  await startTmuxSession(tmuxName, buildClaudeCodeLoginEnv(process.env));
  const session: LoginSession = {
    id,
    tmuxName,
    createdAt: now,
    output: "",
    status: "starting",
    authUrl: null,
    exited: false,
    exitCode: null,
    waiters: [],
    pollTimer: null,
    refreshing: false,
  };
  sessions.set(id, session);
  startPolling(session);
  await refreshTmuxOutput(session);

  const authUrl = await waitForOutput(session, extractClaudeCodeAuthUrl, LOGIN_URL_TIMEOUT_MS, "Claude Code login URL");
  session.authUrl = authUrl;
  session.status = "waiting_for_code";
  return { sessionId: id, authUrl };
}

export async function completeClaudeCodeLogin(sessionId: string, code: string): Promise<ClaudeCodeLoginCompleteResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Claude Code login session expired or not found");
  if (session.status !== "waiting_for_code" && session.status !== "waiting_for_token") {
    throw new Error("Claude Code login session is not waiting for a code");
  }

  const trimmed = code.trim();
  if (!trimmed) throw new Error("Claude Code login code is required");

  const existingToken = extractClaudeCodeTokenFromOutput(session.output);
  if (existingToken) {
    return completeSessionWithToken(session, existingToken);
  }

  if (session.status === "waiting_for_code") {
    await sendTmuxLiteral(session.tmuxName, trimmed);
    session.status = "waiting_for_token";
  }

  const token = await waitForOutput(session, extractClaudeCodeTokenFromOutput, COMPLETE_TIMEOUT_MS, "Claude Code OAuth token");
  return completeSessionWithToken(session, token);
}

export async function getClaudeCodeLoginStatus(sessionId: string): Promise<ClaudeCodeLoginStatusResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Claude Code login session expired or not found");
  await refreshTmuxOutput(session);
  return {
    status: session.status,
    authUrl: session.authUrl,
    output: redactClaudeCodeOutput(cleanClaudeCodeOutput(session.output)).trim().slice(-12_000),
    exited: session.exited,
    exitCode: session.exitCode,
    tokenReady: extractClaudeCodeTokenFromOutput(session.output) !== null,
  };
}

function completeSessionWithToken(session: LoginSession, token: string): ClaudeCodeLoginCompleteResult {
  session.status = "complete";
  sessions.delete(session.id);
  cleanupProcess(session);
  return { token };
}

export function extractClaudeCodeAuthUrl(output: string): string | null {
  const cleaned = cleanClaudeCodeOutput(output);
  const start = cleaned.indexOf("https://claude.com/cai/oauth/authorize?");
  if (start === -1) return null;

  const tail = cleaned.slice(start);
  const stop = tail.search(/\n\s*\n|Paste\s+code\s+here|>/i);
  const rawUrl = (stop === -1 ? tail : tail.slice(0, stop))
    .split("\n")
    .map((line) => line.trim())
    .join("");
  const match = rawUrl.match(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?\S+/);
  return match?.[0] ?? null;
}

export function extractClaudeCodeTokenFromOutput(output: string): string | null {
  return findClaudeCodeOAuthToken(cleanClaudeCodeOutput(output));
}

export function cleanClaudeCodeOutput(output: string): string {
  return stripControlChars(stripAnsiSequences(output)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function redactClaudeCodeOutput(output: string): string {
  return output.replace(
    /((?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*)(?:"[^"]+"|'[^']+'|\S+)/g,
    "$1[redacted]",
  );
}

export function resetClaudeCodeLoginSessionsForTests(): void {
  for (const session of sessions.values()) {
    cleanupProcess(session);
  }
  sessions.clear();
}

export function buildClaudeCodeLoginEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const localBin = `${process.cwd()}/node_modules/.bin`;
  return {
    ...stringEnv(baseEnv),
    PATH: `${localBin}:${baseEnv.PATH ?? ""}`,
    TERM: baseEnv.TERM ?? "xterm-256color",
    CLAUDE_CODE_NO_FLICKER: "0",
    CLAUDE_CODE_LOGIN_COMMAND: baseEnv.CLAUDE_CODE_LOGIN_COMMAND ?? `${shellQuote(`${localBin}/claude`)} setup-token`,
    CLAUDE_CONFIG_DIR: baseEnv.CLAUDE_CONFIG_DIR ?? "./data/claude",
  };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function startPolling(session: LoginSession): void {
  session.pollTimer = setInterval(() => {
    void refreshTmuxOutput(session);
  }, 500);
}

async function refreshTmuxOutput(session: LoginSession): Promise<void> {
  if (session.refreshing) return;
  session.refreshing = true;
  try {
    const output = await runTmux(["capture-pane", "-pt", session.tmuxName, "-S", "-10000"]);
    setOutput(session, output);
  } catch {
    if (session.status !== "complete") {
      session.exited = true;
      session.status = "failed";
      rejectWaiters(session, new Error(`Claude Code tmux session is unavailable.${outputHint(session.output)}`));
    }
  } finally {
    session.refreshing = false;
  }
}

function setOutput(session: LoginSession, output: string): void {
  session.output = output.slice(-MAX_OUTPUT_CHARS);
  for (const waiter of session.waiters.slice()) {
    if (!waiter.check(session.output)) continue;
    clearTimeout(waiter.timeout);
    session.waiters = session.waiters.filter((entry) => entry !== waiter);
  }
  updateExitMarker(session);
}

function updateExitMarker(session: LoginSession): void {
  const exit = /\[cc-lb\] Claude Code process exited with status (\d+)/.exec(cleanClaudeCodeOutput(session.output));
  if (!exit) return;
  session.exited = true;
  session.exitCode = Number(exit[1]);
  if (session.status === "complete" || extractClaudeCodeTokenFromOutput(session.output)) return;
  session.status = "failed";
  rejectWaiters(
    session,
    new Error(`Claude Code login exited before completion (${session.exitCode}).${outputHint(session.output)}`),
  );
}

function waitForOutput<T>(
  session: LoginSession,
  pick: (output: string) => T | null,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const existing = pick(session.output);
  if (existing !== null) return Promise.resolve(existing);
  if (session.exited) {
    return Promise.reject(new Error(`Claude Code login exited before emitting ${label}.${outputHint(session.output)}`));
  }

  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      check: (output) => {
        const value = pick(output);
        if (value === null) return false;
        resolve(value);
        return true;
      },
      reject,
      timeout: setTimeout(() => {
        session.waiters = session.waiters.filter((entry) => entry !== waiter);
        reject(new Error(`Timed out waiting for ${label}.${outputHint(session.output)}`));
      }, timeoutMs),
    };
    session.waiters.push(waiter);
  });
}

function rejectWaiters(session: LoginSession, error: Error): void {
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  session.waiters = [];
}

function cleanupExpiredSessions(now: number): void {
  for (const session of sessions.values()) {
    if (now - session.createdAt <= SESSION_TTL_MS) continue;
    session.status = "failed";
    rejectWaiters(session, new Error("Claude Code login session expired"));
    cleanupProcess(session);
    sessions.delete(session.id);
  }
}

function cleanupProcess(session: LoginSession): void {
  if (session.pollTimer) clearInterval(session.pollTimer);
  session.pollTimer = null;
  void runTmux(["kill-session", "-t", session.tmuxName]).catch(() => {});
}

function outputHint(output: string): string {
  const cleaned = cleanClaudeCodeOutput(output).trim().slice(-500);
  return cleaned ? ` Last output: ${cleaned}` : "";
}

function stripAnsiSequences(input: string): string {
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code !== ESC) {
      output += input[index];
      continue;
    }

    const next = input[index + 1];
    if (next === "]") {
      index = skipOscSequence(input, index + 2);
      continue;
    }
    if (next === "[") {
      index = skipAnsiSequence(input, index + 2);
      continue;
    }
    index += 1;
  }
  return output;
}

function skipOscSequence(input: string, index: number): number {
  for (let cursor = index; cursor < input.length; cursor += 1) {
    if (input.charCodeAt(cursor) === BEL) return cursor;
    if (input.charCodeAt(cursor) === ESC && input[cursor + 1] === "\\") return cursor + 1;
  }
  return input.length - 1;
}

function skipAnsiSequence(input: string, index: number): number {
  for (let cursor = index; cursor < input.length; cursor += 1) {
    const code = input.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor;
  }
  return input.length - 1;
}

function stripControlChars(input: string): string {
  let output = "";
  for (const char of input) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue;
    }
    output += char;
  }
  return output;
}

function tmuxSessionName(id: string): string {
  return `cc-lb-claude-${id.replaceAll("-", "").slice(0, 24)}`;
}

async function startTmuxSession(sessionName: string, env: Record<string, string>): Promise<void> {
  const command = buildTmuxLoginCommand(env);
  try {
    await runTmux(["new-session", "-d", "-s", sessionName, "-x", "500", "-y", "40", "-c", process.cwd(), command]);
  } catch (error) {
    throw new Error(`Failed to start tmux for Claude Code login. Ensure tmux is installed. ${errorMessage(error)}`);
  }
}

export function buildTmuxLoginCommand(env: Record<string, string>): string {
  const exports = [
    ["PATH", env.PATH],
    ["TERM", env.TERM],
    ["CLAUDE_CODE_NO_FLICKER", env.CLAUDE_CODE_NO_FLICKER],
    ["CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("; ");
  return [
    "stty cols 500 rows 40 || true",
    exports,
    `(${env.CLAUDE_CODE_LOGIN_COMMAND})`,
    'status=$?',
    'printf "\\n[cc-lb] Claude Code process exited with status %s\\n" "$status"',
    "sleep 600",
  ]
    .filter(Boolean)
    .join("; ");
}

async function sendTmuxLiteral(sessionName: string, value: string): Promise<void> {
  await runTmux(["send-keys", "-t", sessionName, "-l", value]);
  await runTmux(["send-keys", "-t", sessionName, "Enter"]);
}

async function runTmux(args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["tmux", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: buildClaudeCodeLoginEnv(process.env),
    });
  } catch (error) {
    throw new Error(`tmux failed to start: ${errorMessage(error)}`);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `tmux exited with ${exitCode}`);
  }
  return stdout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

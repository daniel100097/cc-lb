import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findClaudeCodeOAuthToken } from "./credentials";

const LOGIN_URL_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 80_000;
const DEFAULT_TMUX_SOCKET_PATH = "/tmp/cc-lb-claude-code.tmux";
const LOGIN_CONFIG_ROOT = "/tmp/cc-lb-claude-logins";
const ESC = 27;
const BEL = 7;

type LoginStatus = "starting" | "waiting_for_code" | "waiting_for_credentials" | "complete" | "failed";
type ClaudeCodeCredentials = Record<string, unknown>;

interface Waiter {
  check: (output: string) => boolean;
  reject: (error: Error) => void;
  timeout: Timer;
}

interface LoginSession {
  id: string;
  tmuxName: string;
  configDir: string;
  createdAt: number;
  output: string;
  status: LoginStatus;
  authUrl: string | null;
  exited: boolean;
  exitCode: number | null;
  waiters: Waiter[];
  pollTimer: Timer | null;
  refreshing: boolean;
  sentThemeEnter: boolean;
  sentLoginEnter: boolean;
  sentSecurityEnter: boolean;
  sentTrustEnter: boolean;
}

const sessions = new Map<string, LoginSession>();

export interface ClaudeCodeLoginBeginResult {
  sessionId: string;
  authUrl: string;
  tmuxSession: string;
  tmuxSocket: string;
  tmuxAttachCommand: string;
}

export interface ClaudeCodeLoginCompleteResult {
  credentials: ClaudeCodeCredentials;
}

export interface ClaudeCodeLoginStatusResult {
  status: LoginStatus;
  authUrl: string | null;
  output: string;
  exited: boolean;
  exitCode: number | null;
  tokenReady: boolean;
  tmuxSession: string;
  tmuxSocket: string;
  tmuxAttachCommand: string;
}

export async function beginClaudeCodeLogin(now = Date.now()): Promise<ClaudeCodeLoginBeginResult> {
  cleanupExpiredSessions(now);

  const id = randomUUID();
  const tmuxName = tmuxSessionName(id);
  const configDir = claudeLoginConfigDir(id);
  mkdirSync(configDir, { recursive: true });
  await startTmuxSession(tmuxName, buildClaudeCodeLoginEnv(process.env, configDir));
  const session: LoginSession = {
    id,
    tmuxName,
    configDir,
    createdAt: now,
    output: "",
    status: "starting",
    authUrl: null,
    exited: false,
    exitCode: null,
    waiters: [],
    pollTimer: null,
    refreshing: false,
    sentThemeEnter: false,
    sentLoginEnter: false,
    sentSecurityEnter: false,
    sentTrustEnter: false,
  };
  sessions.set(id, session);
  startPolling(session);
  await refreshTmuxOutput(session);

  try {
    const authUrl = await waitForOutput(session, extractClaudeCodeAuthUrl, LOGIN_URL_TIMEOUT_MS, "Claude Code login URL");
    session.authUrl = authUrl;
    session.status = "waiting_for_code";
    return { sessionId: id, authUrl, ...tmuxSessionInfo(session) };
  } catch (error) {
    throw new Error(withAttachHint(session, error));
  }
}

export async function completeClaudeCodeLogin(sessionId: string, code: string): Promise<ClaudeCodeLoginCompleteResult> {
  const session = await getOrRecoverSession(sessionId);
  if (!session) throw new Error("Claude Code login session expired or not found");
  if (session.status !== "waiting_for_code" && session.status !== "waiting_for_credentials") {
    throw new Error("Claude Code login session is not waiting for a code");
  }

  const trimmed = code.trim();
  if (!trimmed) throw new Error("Claude Code login code is required");

  const existingCredentials = extractCompletedClaudeLogin(session, session.output);
  if (existingCredentials) {
    return completeSessionWithCredentials(session, existingCredentials);
  }

  try {
    await sendTmuxLiteral(session.tmuxName, trimmed);
    session.status = "waiting_for_credentials";

    const credentials = await waitForOutput(
      session,
      (output) => extractCompletedClaudeLogin(session, output),
      COMPLETE_TIMEOUT_MS,
      "Claude Code login completion",
    );
    return completeSessionWithCredentials(session, credentials);
  } catch (error) {
    throw new Error(withAttachHint(session, error));
  }
}

export async function getClaudeCodeLoginStatus(sessionId: string): Promise<ClaudeCodeLoginStatusResult> {
  const session = await getOrRecoverSession(sessionId);
  if (!session) throw new Error("Claude Code login session expired or not found");
  await refreshTmuxOutput(session);
  return {
    status: session.status,
    authUrl: session.authUrl,
    output: redactClaudeCodeOutput(cleanClaudeCodeOutput(session.output)).trim().slice(-12_000),
    exited: session.exited,
    exitCode: session.exitCode,
    tokenReady: extractCompletedClaudeLogin(session, session.output) !== null,
    ...tmuxSessionInfo(session),
  };
}

function completeSessionWithCredentials(session: LoginSession, credentials: ClaudeCodeCredentials): ClaudeCodeLoginCompleteResult {
  session.status = "complete";
  sessions.delete(session.id);
  cleanupProcess(session);
  return { credentials };
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

function extractCompletedClaudeLogin(session: LoginSession, output: string): ClaudeCodeCredentials | null {
  const credentials = readClaudeCodeCredentials(session);
  if (!credentials) return null;

  const cleaned = cleanClaudeCodeOutput(output);
  if (cleaned.includes("Welcome back") || cleaned.includes("Tips for getting started")) return credentials;
  return null;
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

export function getClaudeCodeTmuxSocketPath(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return baseEnv.CLAUDE_CODE_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET_PATH;
}

export function getClaudeCodeCredentialsPath(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolve(baseEnv.CLAUDE_CONFIG_DIR ?? "./data/claude"), ".credentials.json");
}

function readClaudeCodeCredentials(session: LoginSession): ClaudeCodeCredentials | null {
  const credentialsPath = join(session.configDir, ".credentials.json");
  if (!existsSync(credentialsPath)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildClaudeCodeLoginEnv(baseEnv: NodeJS.ProcessEnv, configDir = baseEnv.CLAUDE_CONFIG_DIR ?? "./data/claude"): Record<string, string> {
  const localBin = `${process.cwd()}/node_modules/.bin`;
  return {
    ...stringEnv(baseEnv),
    PATH: `${localBin}:${baseEnv.PATH ?? ""}`,
    TERM: baseEnv.TERM ?? "xterm-256color",
    CLAUDE_CODE_NO_FLICKER: "0",
    CLAUDE_CODE_LOGIN_COMMAND: baseEnv.CLAUDE_CODE_LOGIN_COMMAND ?? shellQuote(`${localBin}/claude`),
    CLAUDE_CONFIG_DIR: configDir,
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

async function getOrRecoverSession(sessionId: string): Promise<LoginSession | null> {
  const current = sessions.get(sessionId);
  if (current) return current;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    return null;
  }

  const tmuxName = tmuxSessionName(sessionId);
  try {
    await runTmux(["has-session", "-t", tmuxName]);
  } catch {
    return null;
  }

  const session: LoginSession = {
    id: sessionId,
    tmuxName,
    configDir: claudeLoginConfigDir(sessionId),
    createdAt: Date.now(),
    output: "",
    status: "starting",
    authUrl: null,
    exited: false,
    exitCode: null,
    waiters: [],
    pollTimer: null,
    refreshing: false,
    sentThemeEnter: false,
    sentLoginEnter: false,
    sentSecurityEnter: false,
    sentTrustEnter: false,
  };
  sessions.set(sessionId, session);
  startPolling(session);
  await refreshTmuxOutput(session);
  return session;
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
  updateSessionFromOutput(session);
  driveClaudeLoginPrompts(session);
  for (const waiter of session.waiters.slice()) {
    if (!waiter.check(session.output)) continue;
    clearTimeout(waiter.timeout);
    session.waiters = session.waiters.filter((entry) => entry !== waiter);
  }
  updateExitMarker(session);
}

function updateSessionFromOutput(session: LoginSession): void {
  const authUrl = extractClaudeCodeAuthUrl(session.output);
  if (authUrl) session.authUrl = authUrl;
  if (session.status === "starting" && authUrl) {
    session.status = "waiting_for_code";
  }
}

function updateExitMarker(session: LoginSession): void {
  const exit = /\[cc-lb\] Claude Code process exited with status (\d+)/.exec(cleanClaudeCodeOutput(session.output));
  if (!exit) return;
  session.exited = true;
  session.exitCode = Number(exit[1]);
  if (session.status === "complete" || extractCompletedClaudeLogin(session, session.output)) return;
  session.status = "failed";
  rejectWaiters(
    session,
    new Error(`Claude Code login exited before completion (${session.exitCode}).${outputHint(session.output)}`),
  );
}

function driveClaudeLoginPrompts(session: LoginSession): void {
  const output = cleanClaudeCodeOutput(session.output);
  if (!session.sentThemeEnter && output.includes("Choose the text style that looks best with your terminal")) {
    session.sentThemeEnter = true;
    void sendTmuxKey(session.tmuxName, "Enter");
  }
  if (!session.sentLoginEnter && output.includes("Select login method:")) {
    session.sentLoginEnter = true;
    void sendTmuxKey(session.tmuxName, "Enter");
  }
  if (!session.sentSecurityEnter && output.includes("Press Enter to continue")) {
    session.sentSecurityEnter = true;
    void sendTmuxKey(session.tmuxName, "Enter");
  }
  if (!session.sentTrustEnter && output.includes("Quick safety check") && output.includes("Yes, I trust this folder")) {
    session.sentTrustEnter = true;
    void sendTmuxKey(session.tmuxName, "Enter");
  }
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
  const cleaned = redactClaudeCodeOutput(cleanClaudeCodeOutput(output)).trim().slice(-500);
  return cleaned ? ` Last output: ${cleaned}` : "";
}

function withAttachHint(session: LoginSession, error: unknown): string {
  return `${errorMessage(error)} Attach with: ${tmuxSessionInfo(session).tmuxAttachCommand}`;
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

function claudeLoginConfigDir(id: string): string {
  return join(LOGIN_CONFIG_ROOT, id);
}

function tmuxSessionInfo(session: LoginSession): Pick<
  ClaudeCodeLoginStatusResult,
  "tmuxSession" | "tmuxSocket" | "tmuxAttachCommand"
> {
  const tmuxSocket = getClaudeCodeTmuxSocketPath();
  return {
    tmuxSession: session.tmuxName,
    tmuxSocket,
    tmuxAttachCommand: `tmux -S ${shellQuote(tmuxSocket)} attach -t ${shellQuote(session.tmuxName)}`,
  };
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
  await sendTmuxKey(sessionName, "Enter");
}

async function sendTmuxKey(sessionName: string, key: string): Promise<void> {
  await runTmux(["send-keys", "-t", sessionName, key]);
}

async function runTmux(args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["tmux", "-S", getClaudeCodeTmuxSocketPath(), ...args], {
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

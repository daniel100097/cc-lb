import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findClaudeCodeOAuthToken } from "./credentials";
import {
  adoptPaneSession,
  claudeScreenReady,
  cleanClaudeCodeOutput,
  getClaudeCodeTmuxSocketPath,
  killPaneSession,
  outputHint,
  type PaneSession,
  refreshPaneOutput,
  rejectWaiters,
  runTmux,
  sendTmuxLiteral,
  shellQuote,
  startPaneSession,
  waitForOutput,
} from "./tmux-driver";

const LOGIN_URL_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const LOGIN_CONFIG_ROOT = "/tmp/cc-lb-claude-logins";

// Login answers every startup prompt; "paste_code" is handled by the driver as never-auto-answered.
const LOGIN_AUTO_ANSWER = { theme: true, loginMethod: true, security: true, trust: true } as const;

type LoginStatus = "starting" | "waiting_for_code" | "waiting_for_credentials" | "complete" | "failed";
type ClaudeCodeCredentials = Record<string, unknown>;

interface LoginSession {
  id: string;
  pane: PaneSession;
  configDir: string;
  createdAt: number;
  status: LoginStatus;
  authUrl: string | null;
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
  configDir: string;
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
  const configDir = claudeLoginConfigDir(id);
  mkdirSync(configDir, { recursive: true });
  const pane = await startPaneSession({
    tmuxName: tmuxSessionName(id),
    configDir,
    autoAnswer: LOGIN_AUTO_ANSWER,
    onOutput: onLoginPaneOutput,
  });
  const session: LoginSession = {
    id,
    pane,
    configDir,
    createdAt: now,
    status: "starting",
    authUrl: null,
  };
  loginSessionByPane.set(pane, session);
  sessions.set(id, session);
  await refreshPaneOutput(pane);

  try {
    const authUrl = await waitForOutput(pane, extractClaudeCodeAuthUrl, LOGIN_URL_TIMEOUT_MS, "Claude Code login URL");
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

  const existingCredentials = extractCompletedClaudeLogin(session, session.pane.output);
  if (existingCredentials) {
    return completeSessionWithCredentials(session, existingCredentials);
  }

  try {
    await sendTmuxLiteral(session.pane.tmuxName, trimmed);
    session.status = "waiting_for_credentials";

    const credentials = await waitForOutput(
      session.pane,
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
  await refreshPaneOutput(session.pane);
  return {
    status: session.status,
    authUrl: session.authUrl,
    output: redactClaudeCodeOutput(cleanClaudeCodeOutput(session.pane.output)).trim().slice(-12_000),
    exited: session.pane.exited,
    exitCode: session.pane.exitCode,
    tokenReady: extractCompletedClaudeLogin(session, session.pane.output) !== null,
    ...tmuxSessionInfo(session),
  };
}

function completeSessionWithCredentials(session: LoginSession, credentials: ClaudeCodeCredentials): ClaudeCodeLoginCompleteResult {
  session.status = "complete";
  sessions.delete(session.id);
  loginSessionByPane.delete(session.pane);
  // Kill the pane but keep the config dir on disk — the router adopts it into
  // the account's persistent config dir right after createAccount.
  void killPaneSession(session.pane);
  return { credentials, configDir: session.configDir };
}

// Pane → login session backref for the onOutput hook (driver knows nothing about logins).
const loginSessionByPane = new WeakMap<PaneSession, LoginSession>();

function onLoginPaneOutput(pane: PaneSession): void {
  const session = loginSessionByPane.get(pane);
  if (!session) return;
  const authUrl = extractClaudeCodeAuthUrl(pane.output);
  if (authUrl) session.authUrl = authUrl;
  if (session.status === "starting" && authUrl) {
    session.status = "waiting_for_code";
  }
  if (pane.exited) {
    handleLoginPaneExit(session);
  }
}

function handleLoginPaneExit(session: LoginSession): void {
  if (session.status === "complete" || extractCompletedClaudeLogin(session, session.pane.output)) return;
  session.status = "failed";
  rejectWaiters(
    session.pane,
    new Error(
      `Claude Code login exited before completion (${session.pane.exitCode ?? "unknown"}).${outputHint(session.pane.output)}`,
    ),
  );
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

  if (claudeScreenReady(cleanClaudeCodeOutput(output))) return credentials;
  return null;
}

export function redactClaudeCodeOutput(output: string): string {
  return output.replace(
    /((?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*)(?:"[^"]+"|'[^']+'|\S+)/g,
    "$1[redacted]",
  );
}

export function resetClaudeCodeLoginSessionsForTests(): void {
  for (const session of sessions.values()) {
    void killPaneSession(session.pane);
  }
  sessions.clear();
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

  const pane = adoptPaneSession({
    tmuxName,
    configDir: claudeLoginConfigDir(sessionId),
    autoAnswer: LOGIN_AUTO_ANSWER,
    onOutput: onLoginPaneOutput,
  });
  const session: LoginSession = {
    id: sessionId,
    pane,
    configDir: claudeLoginConfigDir(sessionId),
    createdAt: Date.now(),
    status: "starting",
    authUrl: null,
  };
  loginSessionByPane.set(pane, session);
  sessions.set(sessionId, session);
  await refreshPaneOutput(pane);
  return session;
}

function cleanupExpiredSessions(now: number): void {
  for (const session of sessions.values()) {
    if (now - session.createdAt <= SESSION_TTL_MS) continue;
    session.status = "failed";
    rejectWaiters(session.pane, new Error("Claude Code login session expired"));
    void killPaneSession(session.pane);
    loginSessionByPane.delete(session.pane);
    sessions.delete(session.id);
  }
}

function withAttachHint(session: LoginSession, error: unknown): string {
  return `${errorMessage(error)} Attach with: ${tmuxSessionInfo(session).tmuxAttachCommand}`;
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
    tmuxSession: session.pane.tmuxName,
    tmuxSocket,
    tmuxAttachCommand: `tmux -S ${shellQuote(tmuxSocket)} attach -t ${shellQuote(session.pane.tmuxName)}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Legacy names — claude-code-cli.test.ts and older callers import these from here.
export { cleanClaudeCodeOutput, getClaudeCodeTmuxSocketPath } from "./tmux-driver";
export { buildClaudeCliEnv as buildClaudeCodeLoginEnv, buildTmuxClaudeCommand as buildTmuxLoginCommand } from "./tmux-driver";

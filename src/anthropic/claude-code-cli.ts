import { randomUUID } from "node:crypto";
import { findClaudeCodeOAuthToken } from "./credentials";

const LOGIN_URL_TIMEOUT_MS = 30_000;
const COMPLETE_TIMEOUT_MS = 120_000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 80_000;
const ESC = 27;
const BEL = 7;

type LoginStatus = "starting" | "waiting_for_code" | "complete" | "failed";

interface Waiter {
  check: (output: string) => boolean;
  reject: (error: Error) => void;
  timeout: Timer;
}

interface LoginSession {
  id: string;
  process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  createdAt: number;
  output: string;
  status: LoginStatus;
  authUrl: string | null;
  exited: boolean;
  exitCode: number | null;
  waiters: Waiter[];
}

const sessions = new Map<string, LoginSession>();

export interface ClaudeCodeLoginBeginResult {
  sessionId: string;
  authUrl: string;
}

export interface ClaudeCodeLoginCompleteResult {
  token: string;
}

export async function beginClaudeCodeLogin(now = Date.now()): Promise<ClaudeCodeLoginBeginResult> {
  cleanupExpiredSessions(now);

  const id = randomUUID();
  const child = spawnClaudeCodeSetupToken();
  const session: LoginSession = {
    id,
    process: child,
    createdAt: now,
    output: "",
    status: "starting",
    authUrl: null,
    exited: false,
    exitCode: null,
    waiters: [],
  };
  sessions.set(id, session);

  readProcessOutput(session, child.stdout);
  readProcessOutput(session, child.stderr);
  void child.exited.then((exitCode) => {
    session.exited = true;
    session.exitCode = exitCode;
    if (session.status !== "complete") {
      session.status = "failed";
      rejectWaiters(session, new Error(`Claude Code login exited before completion (${exitCode}).${outputHint(session.output)}`));
    }
  });

  const authUrl = await waitForOutput(session, extractClaudeCodeAuthUrl, LOGIN_URL_TIMEOUT_MS, "Claude Code login URL");
  session.authUrl = authUrl;
  session.status = "waiting_for_code";
  return { sessionId: id, authUrl };
}

export async function completeClaudeCodeLogin(sessionId: string, code: string): Promise<ClaudeCodeLoginCompleteResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Claude Code login session expired or not found");
  if (session.status !== "waiting_for_code") throw new Error("Claude Code login session is not waiting for a code");

  const trimmed = code.trim();
  if (!trimmed) throw new Error("Claude Code login code is required");

  await session.process.stdin.write(`${trimmed}\n`);
  await session.process.stdin.flush();

  const token = await waitForOutput(session, extractClaudeCodeTokenFromOutput, COMPLETE_TIMEOUT_MS, "Claude Code OAuth token");
  session.status = "complete";
  sessions.delete(session.id);
  await session.process.stdin.end();
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

export function resetClaudeCodeLoginSessionsForTests(): void {
  for (const session of sessions.values()) {
    cleanupProcess(session);
  }
  sessions.clear();
}

function spawnClaudeCodeSetupToken(): Bun.Subprocess<"pipe", "pipe", "pipe"> {
  const helperPath = new URL("./claude-code-pty.py", import.meta.url).pathname;
  return Bun.spawn(["python3", helperPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: process.env.TERM ?? "xterm-256color",
      CLAUDE_CODE_NO_FLICKER: "0",
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "./data/claude",
    },
  });
}

function readProcessOutput(session: LoginSession, stream: ReadableStream<Uint8Array>): void {
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of stream) {
        appendOutput(session, decoder.decode(chunk, { stream: true }));
      }
    } catch (error) {
      if (!session.exited) {
        rejectWaiters(session, new Error(error instanceof Error ? error.message : "Failed reading Claude Code output"));
      }
    }
  })();
}

function appendOutput(session: LoginSession, chunk: string): void {
  session.output = `${session.output}${chunk}`.slice(-MAX_OUTPUT_CHARS);
  for (const waiter of session.waiters.slice()) {
    if (!waiter.check(session.output)) continue;
    clearTimeout(waiter.timeout);
    session.waiters = session.waiters.filter((entry) => entry !== waiter);
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
  if (session.exited) return;
  setTimeout(() => {
    if (!session.exited) session.process.kill();
  }, 2_000);
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

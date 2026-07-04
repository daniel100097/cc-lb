// Generic tmux pane driver for running the Claude Code CLI. Shared by the
// dashboard login flow (claude-code-cli.ts) and the account probe
// (account-probe.ts). One tmux server on a dedicated socket hosts all panes.

const DEFAULT_TMUX_SOCKET_PATH = "/tmp/cc-lb-claude-code.tmux";
const MAX_OUTPUT_CHARS = 80_000;
const PROMPT_RETRY_MS = 1_500;
const ESC = 27;
const BEL = 7;

export interface PromptAutoAnswer {
  theme: boolean;
  loginMethod: boolean;
  security: boolean;
  trust: boolean;
}

export interface PaneSessionOptions {
  tmuxName: string;
  configDir: string;
  cwd?: string;
  autoAnswer: PromptAutoAnswer;
  /** Called after every capture refresh, before waiters are checked. */
  onOutput?: (session: PaneSession) => void;
  pollMs?: number;
}

interface Waiter {
  check: (output: string) => boolean;
  reject: (error: Error) => void;
  timeout: Timer;
}

export interface PaneSession {
  tmuxName: string;
  configDir: string;
  output: string;
  exited: boolean;
  exitCode: number | null;
  waiters: Waiter[];
  pollTimer: Timer | null;
  refreshing: boolean;
  autoAnswer: PromptAutoAnswer;
  onOutput?: (session: PaneSession) => void;
  promptEnterSentAt: Record<ClaudePrompt, number>;
}

export type ClaudePrompt = "theme" | "login_method" | "paste_code" | "security" | "trust";

const READY_MARKERS = ["Welcome back", "Tips for getting started"] as const;

export function claudeScreenReady(screen: string): boolean {
  return READY_MARKERS.some((marker) => screen.includes(marker));
}

export function getClaudeCodeTmuxSocketPath(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return baseEnv.CLAUDE_CODE_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET_PATH;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildClaudeCliEnv(
  baseEnv: NodeJS.ProcessEnv,
  configDir = baseEnv.CLAUDE_CONFIG_DIR ?? "./data/claude",
): Record<string, string> {
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

export function buildTmuxClaudeCommand(env: Record<string, string>): string {
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

export async function startPaneSession(options: PaneSessionOptions): Promise<PaneSession> {
  const env = buildClaudeCliEnv(process.env, options.configDir);
  const command = buildTmuxClaudeCommand(env);
  try {
    await runTmux([
      "new-session",
      "-d",
      "-s",
      options.tmuxName,
      "-x",
      "500",
      "-y",
      "40",
      "-c",
      options.cwd ?? process.cwd(),
      command,
    ]);
  } catch (error) {
    throw new Error(`Failed to start tmux for Claude Code. Ensure tmux is installed. ${errorMessage(error)}`);
  }

  const session: PaneSession = {
    tmuxName: options.tmuxName,
    configDir: options.configDir,
    output: "",
    exited: false,
    exitCode: null,
    waiters: [],
    pollTimer: null,
    refreshing: false,
    autoAnswer: options.autoAnswer,
    onOutput: options.onOutput,
    promptEnterSentAt: { theme: 0, login_method: 0, paste_code: 0, security: 0, trust: 0 },
  };
  session.pollTimer = setInterval(() => {
    void refreshPaneOutput(session);
  }, options.pollMs ?? 500);
  await refreshPaneOutput(session);
  return session;
}

/** Attach to a pane that already exists on the socket (login-session recovery). */
export function adoptPaneSession(options: PaneSessionOptions): PaneSession {
  const session: PaneSession = {
    tmuxName: options.tmuxName,
    configDir: options.configDir,
    output: "",
    exited: false,
    exitCode: null,
    waiters: [],
    pollTimer: null,
    refreshing: false,
    autoAnswer: options.autoAnswer,
    onOutput: options.onOutput,
    promptEnterSentAt: { theme: 0, login_method: 0, paste_code: 0, security: 0, trust: 0 },
  };
  session.pollTimer = setInterval(() => {
    void refreshPaneOutput(session);
  }, options.pollMs ?? 500);
  return session;
}

export async function refreshPaneOutput(session: PaneSession): Promise<void> {
  if (session.refreshing) return;
  session.refreshing = true;
  try {
    const output = await runTmux(["capture-pane", "-pt", session.tmuxName, "-S", "-10000"]);
    setOutput(session, output);
  } catch {
    if (!session.exited) {
      session.exited = true;
      rejectWaiters(session, new Error(`Claude Code tmux session is unavailable.${outputHint(session.output)}`));
    }
  } finally {
    session.refreshing = false;
  }
}

function setOutput(session: PaneSession, output: string): void {
  session.output = output.slice(-MAX_OUTPUT_CHARS);
  updateExitMarker(session);
  driveClaudeStartupPrompts(session);
  session.onOutput?.(session);
  for (const waiter of session.waiters.slice()) {
    if (!waiter.check(session.output)) continue;
    clearTimeout(waiter.timeout);
    session.waiters = session.waiters.filter((entry) => entry !== waiter);
  }
  if (session.exited && session.waiters.length > 0) {
    rejectWaiters(
      session,
      new Error(`Claude Code exited with status ${session.exitCode ?? "unknown"}.${outputHint(session.output)}`),
    );
  }
}

function updateExitMarker(session: PaneSession): void {
  const exit = /\[cc-lb\] Claude Code process exited with status (\d+)/.exec(cleanClaudeCodeOutput(session.output));
  if (!exit) return;
  session.exited = true;
  session.exitCode = Number(exit[1]);
}

/** Auto-answer Claude Code startup prompts (theme/login/security/trust), gated per prompt. */
function driveClaudeStartupPrompts(session: PaneSession, now = Date.now()): void {
  const screen = currentScreenText(session.output);
  if (claudeScreenReady(screen)) return;

  const latestPrompt = latestClaudePrompt(screen);
  if (latestPrompt === null || latestPrompt === "paste_code") return;
  const allowed: Record<Exclude<ClaudePrompt, "paste_code">, boolean> = {
    theme: session.autoAnswer.theme,
    login_method: session.autoAnswer.loginMethod,
    security: session.autoAnswer.security,
    trust: session.autoAnswer.trust,
  };
  if (!allowed[latestPrompt]) return;
  const lastSentAt = session.promptEnterSentAt[latestPrompt];
  if (now - lastSentAt < PROMPT_RETRY_MS) return;
  session.promptEnterSentAt[latestPrompt] = now;
  void sendTmuxKey(session.tmuxName, "C-m");
}

export function latestClaudePrompt(screen: string): ClaudePrompt | null {
  const prompts: Array<{ name: ClaudePrompt; index: number }> = [
    { name: "theme", index: screen.lastIndexOf("Choose the text style that looks best with your terminal") },
    { name: "login_method", index: screen.lastIndexOf("Select login method:") },
    { name: "paste_code", index: screen.lastIndexOf("Paste code here if prompted") },
    { name: "security", index: screen.lastIndexOf("Press Enter to continue") },
    {
      name: "trust",
      index:
        screen.includes("Quick safety check") && screen.includes("Yes, I trust this folder")
          ? screen.lastIndexOf("Quick safety check")
          : -1,
    },
  ];
  const latest = prompts
    .filter((prompt) => prompt.index >= 0)
    .sort((left, right) => right.index - left.index)
    .at(0);
  return latest?.name ?? null;
}

export function currentScreenText(output: string): string {
  return cleanClaudeCodeOutput(output).split("\n").slice(-80).join("\n");
}

export function waitForOutput<T>(
  session: PaneSession,
  pick: (output: string) => T | null,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const existing = pick(session.output);
  if (existing !== null) return Promise.resolve(existing);
  if (session.exited) {
    return Promise.reject(new Error(`Claude Code exited before emitting ${label}.${outputHint(session.output)}`));
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

export function rejectWaiters(session: PaneSession, error: Error): void {
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
  session.waiters = [];
}

export function outputHint(output: string): string {
  const cleaned = cleanClaudeCodeOutput(output).trim().slice(-500);
  return cleaned ? ` Last output: ${cleaned}` : "";
}

export async function killPaneSession(session: PaneSession): Promise<void> {
  if (session.pollTimer) clearInterval(session.pollTimer);
  session.pollTimer = null;
  await killTmuxSession(session.tmuxName);
}

export async function killTmuxSession(name: string): Promise<void> {
  await runTmux(["kill-session", "-t", name]).catch(() => {});
}

export async function sendTmuxLiteral(sessionName: string, value: string): Promise<void> {
  await runTmux(["send-keys", "-t", sessionName, "-l", value]);
  await sendTmuxKey(sessionName, "Enter");
}

export async function sendTmuxKey(sessionName: string, key: string): Promise<void> {
  await runTmux(["send-keys", "-t", sessionName, key]);
}

export async function runTmux(args: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["tmux", "-S", getClaudeCodeTmuxSocketPath(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: buildClaudeCliEnv(process.env),
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

export function cleanClaudeCodeOutput(output: string): string {
  return stripControlChars(stripAnsiSequences(output)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Token refresh via the real Claude Code CLI. Claude Code owns each account's
// .credentials.json; we never write it. To refresh, we boot `claude` in tmux
// against the account's config dir and run /usage — an authenticated call that
// makes the CLI refresh its own token when needed — then re-read the file.
// /usage also yields the utilization panel we persist for the dashboard.
//
// Concurrency: one probe per account (inFlight dedup) shared by the request
// path, background kicks, and the manual dashboard button; a global semaphore
// caps simultaneous tmux boots. Single Bun process — no cross-process locking.

import { getAccount, updateAccount } from "../db/accounts";
import {
  accountConfigDir,
  accountWorkspaceDir,
  ensureAccountWorkspace,
  type FileCredentials,
  readCredentialsFile,
} from "./account-config";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "./constants";
import {
  cleanClaudeCodeOutput,
  claudeScreenReady,
  currentScreenText,
  killPaneSession,
  killTmuxSession,
  type PaneSession,
  sendTmuxLiteral,
  startPaneSession,
  waitForOutput,
} from "./tmux-driver";
import { parseUsagePanel, type UsageSnapshot, usagePanelVisible } from "./usage-panel";

const PROBE_BOOT_TIMEOUT_MS = 90_000;
const PROBE_USAGE_TIMEOUT_MS = 30_000;
const PROBE_USAGE_SETTLE_MS = 1_000;
const PROBE_TOTAL_TIMEOUT_MS = 150_000;
const PROBE_NOOP_COOLDOWN_MS = 10 * 60_000;
const PROBE_CONCURRENCY = 2;

export type ProbeTrigger = "expired" | "safety_window" | "manual" | "seed" | "usage";
export type ProbeOutcome = "refreshed" | "valid_noop" | "skipped_cooldown";

export interface ProbeResult {
  outcome: ProbeOutcome;
  usage: UsageSnapshot | null;
}

export class ProbeReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeReauthRequiredError";
  }
}

export function isProbeReauthRequiredError(error: unknown): boolean {
  return error instanceof ProbeReauthRequiredError;
}

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(count: number) {
    this.available = count;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

const inFlight = new Map<string, Promise<ProbeResult>>();
const lastFailureAt = new Map<string, number>();
const lastNoopAt = new Map<string, number>();
const livePanes = new Set<PaneSession>();
const semaphore = new Semaphore(PROBE_CONCURRENCY);

export function probeTmuxSessionName(accountId: string): string {
  return `cc-lb-probe-${accountId.replaceAll("-", "").slice(0, 24)}`;
}

export async function probeAccount(accountId: string, trigger: ProbeTrigger): Promise<ProbeResult> {
  const existing = inFlight.get(accountId);
  if (existing) return existing;

  const now = Date.now();

  if (trigger !== "manual") {
    const failedAt = lastFailureAt.get(accountId);
    if (failedAt !== undefined && now - failedAt < TOKEN_REFRESH_BACKOFF_MS) {
      const file = readCredentialsFile(accountId);
      if (file && tokenValidBeyondWindow(file, now)) {
        return { outcome: "valid_noop", usage: null };
      }
      throw new Error(`probe backing off for account ${accountId}`);
    }
  }

  if (trigger === "safety_window" || trigger === "seed") {
    const noopAt = lastNoopAt.get(accountId);
    if (noopAt !== undefined && now - noopAt < PROBE_NOOP_COOLDOWN_MS) {
      return { outcome: "skipped_cooldown", usage: null };
    }
  }

  const promise = runProbe(accountId, trigger).finally(() => inFlight.delete(accountId));
  inFlight.set(accountId, promise);
  return promise;
}

async function runProbe(accountId: string, trigger: ProbeTrigger): Promise<ProbeResult> {
  try {
    const result = await withTotalTimeout(accountId, () => executeProbe(accountId, trigger));
    lastFailureAt.delete(accountId);
    return result;
  } catch (error) {
    lastFailureAt.set(accountId, Date.now());
    throw error;
  }
}

async function executeProbe(accountId: string, trigger: ProbeTrigger): Promise<ProbeResult> {
  const now = Date.now();
  if (!getAccount(accountId)) throw new Error(`account ${accountId} not found`);

  const before = readCredentialsFile(accountId);

  // Fast path: the credentials file already satisfies the trigger's need — no
  // need to boot the CLI. Manual and usage triggers always boot: both exist to
  // capture a fresh /usage panel, not just to keep the token alive.
  if (trigger !== "manual" && trigger !== "usage" && before && triggerSatisfied(before, trigger, now)) {
    return { outcome: trigger === "expired" ? "refreshed" : "valid_noop", usage: null };
  }

  ensureAccountWorkspace(accountId);

  await semaphore.acquire();
  const tmuxName = probeTmuxSessionName(accountId);
  await killTmuxSession(tmuxName); // kill-before-start: clear a crashed probe's pane
  let session: PaneSession | null = null;
  try {
    session = await startPaneSession({
      tmuxName,
      configDir: accountConfigDir(accountId),
      cwd: accountWorkspaceDir(accountId),
      // loginMethod:false — reaching the login screen means the refresh token is
      // dead; we detect it rather than auto-answering it.
      autoAnswer: { theme: true, loginMethod: false, security: true, trust: true },
    });
    livePanes.add(session);

    const bootState = await waitForOutput(session, pickBootState, PROBE_BOOT_TIMEOUT_MS, "Claude Code prompt");
    if (bootState === "login") {
      markNeedsReauth(accountId);
      throw new ProbeReauthRequiredError(`account ${accountId} refresh token is dead (login screen)`);
    }

    const usage = await captureUsage(session);

    const after = readRefreshedCredentials(accountId);
    const changed = after !== null && after.accessToken !== before?.accessToken;

    let outcome: ProbeOutcome;
    if (changed) {
      // File already holds the new token (CLI wrote it) — nothing to persist.
      clearNeedsReauth(accountId);
      outcome = "refreshed";
    } else if (after === null) {
      throw new Error(`account ${accountId} has no readable credentials after probe`);
    } else if ((after.expiresAt ?? 0) > Date.now()) {
      lastNoopAt.set(accountId, Date.now());
      outcome = "valid_noop";
    } else {
      markNeedsReauth(accountId);
      throw new ProbeReauthRequiredError(`account ${accountId} token still expired after probe`);
    }

    if (usage) {
      updateAccount(accountId, {
        usage_windows: JSON.stringify(usage.windows),
        usage_checked_at: usage.capturedAt,
      });
    }

    return { outcome, usage };
  } finally {
    if (session) {
      livePanes.delete(session);
      await killPaneSession(session);
    }
    semaphore.release();
  }
}

/** /usage capture is best-effort — a parse/timeout failure must not fail the refresh. */
async function captureUsage(session: PaneSession): Promise<UsageSnapshot | null> {
  try {
    await sendTmuxLiteral(session.tmuxName, "/usage");
    await waitForOutput(
      session,
      (output) => (usagePanelVisible(cleanClaudeCodeOutput(output)) ? true : null),
      PROBE_USAGE_TIMEOUT_MS,
      "usage panel",
    );
    await sleep(PROBE_USAGE_SETTLE_MS);
    return parseUsagePanel(cleanClaudeCodeOutput(session.output));
  } catch {
    return null;
  }
}

function readRefreshedCredentials(accountId: string): FileCredentials | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = readCredentialsFile(accountId);
    if (file) return file;
    if (attempt < 2) Bun.sleepSync(500);
  }
  return null;
}

function pickBootState(output: string): "login" | "ready" | null {
  const screen = currentScreenText(output);
  if (screen.includes("Select login method:")) return "login";
  if (claudeScreenReady(screen)) return "ready";
  return null;
}

function triggerSatisfied(file: FileCredentials, trigger: ProbeTrigger, now: number): boolean {
  const expiresAt = file.expiresAt ?? 0;
  if (trigger === "expired") return expiresAt > now;
  return expiresAt - now > TOKEN_SAFETY_WINDOW_MS; // safety_window / seed
}

function tokenValidBeyondWindow(file: FileCredentials, now: number): boolean {
  return (file.expiresAt ?? 0) - now > TOKEN_SAFETY_WINDOW_MS;
}

function markNeedsReauth(accountId: string): void {
  updateAccount(accountId, { needs_reauth: 1 });
}

function clearNeedsReauth(accountId: string): void {
  const account = getAccount(accountId);
  if (account?.needs_reauth === 1) updateAccount(accountId, { needs_reauth: 0 });
}

async function withTotalTimeout<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void killTmuxSession(probeTmuxSessionName(accountId));
      reject(new Error(`probe timed out for account ${accountId}`));
    }, PROBE_TOTAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resetProbeStateForTests(): Promise<void> {
  for (const session of livePanes) {
    await killPaneSession(session);
  }
  livePanes.clear();
  inFlight.clear();
  lastFailureAt.clear();
  lastNoopAt.clear();
}

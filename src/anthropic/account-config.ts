// Per-account Claude Code config dirs. Each pooled account owns
// ./data/claude-accounts/<accountId>/ which Claude Code manages: its
// .credentials.json is the sole source of truth for the account's tokens.
// cc-lb only READS that file and adopts a completed login dir into place — it
// never writes credentials itself.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const credentialsFileSchema = z
  .object({
    claudeAiOauth: z.object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      expiresAt: z.number().optional(),
      scopes: z.array(z.string()).optional(),
    }),
  })
  .passthrough();

export interface FileCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  scopes: string | null;
}

export function accountsConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CLAUDE_ACCOUNTS_DIR ?? "./data/claude-accounts");
}

export function accountConfigDir(accountId: string): string {
  return join(accountsConfigRoot(), accountId);
}

export function accountWorkspaceDir(accountId: string): string {
  return join(accountConfigDir(accountId), "workspace");
}

export function accountCredentialsPath(accountId: string): string {
  return join(accountConfigDir(accountId), ".credentials.json");
}

/** Read the CLI-managed credentials file — the account's token source of truth. */
export function readCredentialsFile(accountId: string): FileCredentials | null {
  const path = accountCredentialsPath(accountId);
  if (!existsSync(path)) return null;
  try {
    const parsed = credentialsFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) return null;
    const oauth = parsed.data.claudeAiOauth;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes.join(" ") : null,
    };
  } catch {
    return null;
  }
}

/** Access-token expiry (ms epoch) from the credentials file, for dashboard display. */
export function accountTokenExpiry(accountId: string): number | null {
  return readCredentialsFile(accountId)?.expiresAt ?? null;
}

export function accountHasCredentials(accountId: string): boolean {
  return existsSync(accountCredentialsPath(accountId));
}

// Claude Code stores its persistent identity in .claude.json: machineID (the
// value it sends as x-device-id / body device_id) and accountUuid (the real
// Anthropic account id it sends as body account_uuid). Both are stable for the
// life of the config dir, and .claude.json can be large (project history), so we
// regex them out once and cache rather than JSON.parse on every request.
const deviceIdCache = new Map<string, string>();
const accountUuidCache = new Map<string, string>();

function readFolderIdentity(accountId: string): void {
  const path = join(accountConfigDir(accountId), ".claude.json");
  if (!existsSync(path)) return;
  try {
    const text = readFileSync(path, "utf8");
    const machineId = /"machineID"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    const accountUuid = /"accountUuid"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    if (machineId) deviceIdCache.set(accountId, machineId);
    if (accountUuid) accountUuidCache.set(accountId, accountUuid);
  } catch {
    // Unreadable/partial file — leave caches untouched, retry next call.
  }
}

/** The account's own Claude device id (machineID) from its config dir, or null. */
export function accountDeviceId(accountId: string): string | null {
  const cached = deviceIdCache.get(accountId);
  if (cached !== undefined) return cached;
  readFolderIdentity(accountId);
  return deviceIdCache.get(accountId) ?? null;
}

/** The account's real Anthropic account UUID (accountUuid) from its config dir, or null. */
export function accountRealUuid(accountId: string): string | null {
  const cached = accountUuidCache.get(accountId);
  if (cached !== undefined) return cached;
  readFolderIdentity(accountId);
  return accountUuidCache.get(accountId) ?? null;
}

function clearAccountFolderCaches(accountId: string): void {
  deviceIdCache.delete(accountId);
  accountUuidCache.delete(accountId);
}

/** Ensure the workspace subdir the probe boots `claude` in exists. */
export function ensureAccountWorkspace(accountId: string): void {
  mkdirSync(accountWorkspaceDir(accountId), { recursive: true });
}

/** Copy a completed CLI-login config dir (onboarded .claude.json + .credentials.json) into the account dir. */
export function adoptLoginConfigDir(accountId: string, sourceDir: string): void {
  if (!existsSync(sourceDir)) return;
  mkdirSync(accountConfigDir(accountId), { recursive: true });
  cpSync(sourceDir, accountConfigDir(accountId), { recursive: true });
  ensureAccountWorkspace(accountId);
  clearAccountFolderCaches(accountId);
}

export function deleteAccountConfigDir(accountId: string): void {
  rmSync(accountConfigDir(accountId), { recursive: true, force: true });
  clearAccountFolderCaches(accountId);
}

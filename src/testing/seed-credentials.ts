// Test/seed helper: write a Claude-Code-style .credentials.json into an
// account's config dir so getValidAccessToken (which reads the file as the
// token source of truth) returns a token without booting the CLI. Set
// process.env.CLAUDE_ACCOUNTS_DIR to a temp dir before using this.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountConfigDir, accountCredentialsPath } from "../anthropic/account-config";

export interface SeedCredentialsOptions {
  accessToken?: string;
  refreshToken?: string;
  /** ms epoch; defaults to 1h in the future (well past the 30-min safety window). */
  expiresAt?: number;
  scopes?: string[];
  /** Real accountUuid fixture; defaults to accountId. Null deliberately omits identity. */
  accountUuid?: string | null;
  /** Real machineID fixture from .claude.json. Null/undefined deliberately omits it. */
  machineId?: string | null;
}

export function seedAccountCredentials(accountId: string, options: SeedCredentialsOptions = {}): void {
  mkdirSync(accountConfigDir(accountId), { recursive: true });
  const payload = {
    claudeAiOauth: {
      accessToken: options.accessToken ?? "test-access",
      refreshToken: options.refreshToken ?? "test-refresh",
      expiresAt: options.expiresAt ?? Date.now() + 3_600_000,
      scopes: options.scopes ?? ["user:inference"],
    },
  };
  writeFileSync(accountCredentialsPath(accountId), JSON.stringify(payload));
  const accountUuid = options.accountUuid === undefined ? accountId : options.accountUuid;
  const identity: Record<string, string> = {};
  if (accountUuid !== null) identity.accountUuid = accountUuid;
  if (options.machineId) identity.machineID = options.machineId;
  if (Object.keys(identity).length > 0) {
    writeFileSync(join(accountConfigDir(accountId), ".claude.json"), JSON.stringify(identity));
  }
}

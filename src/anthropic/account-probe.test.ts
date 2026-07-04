import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-probe-test-${process.pid}.db`;
const accountsDir = `/tmp/cc-lb-probe-accounts-${process.pid}`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
rmSync(accountsDir, { recursive: true, force: true });
process.env.DB_PATH = dbPath;
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;

const { createAccount, getAccount } = await import("../db/accounts");
const { probeAccount, resetProbeStateForTests } = await import("./account-probe");
const { seedAccountCredentials } = await import("../testing/seed-credentials");
const { readCredentialsFile } = await import("./account-config");

const FUTURE = 1_900_000_000_000; // year 2030
// %% so the fake's printf emits a literal percent instead of eating it as a format spec.
const PANEL =
  "Current session\\n  0%% used\\nResets 3:59pm (Europe/Berlin)\\n\\nCurrent week (all models)\\n  36%% used\\nResets Jul 5, 1:59pm (Europe/Berlin)\\n";

/** A fake `claude` that prints the ready banner, rewrites credentials, waits for /usage, and prints the panel. */
function fakeRefreshCli(accessToken: string, expiresAt: number): string {
  const creds = `{"claudeAiOauth":{"accessToken":"${accessToken}","refreshToken":"r","expiresAt":${expiresAt},"scopes":["user:inference"]}}`;
  return (
    `printf 'Welcome back\\n'; mkdir -p "$CLAUDE_CONFIG_DIR"; ` +
    `printf '%s' '${creds}' > "$CLAUDE_CONFIG_DIR/.credentials.json"; ` +
    `read cmd; printf '${PANEL}'; sleep 30`
  );
}

afterEach(async () => {
  await resetProbeStateForTests();
  delete process.env.CLAUDE_CODE_LOGIN_COMMAND;
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  rmSync(accountsDir, { recursive: true, force: true });
});

describe("probeAccount", () => {
  test("refreshes the token and captures usage when the CLI rewrites credentials", async () => {
    const account = createAccount({ name: "Refresh" });
    seedAccountCredentials(account.id, { accessToken: "old-tok", expiresAt: Date.now() - 1_000 });
    process.env.CLAUDE_CODE_LOGIN_COMMAND = fakeRefreshCli("new-tok", FUTURE);

    const result = await probeAccount(account.id, "manual");

    expect(result.outcome).toBe("refreshed");
    expect(readCredentialsFile(account.id)?.accessToken).toBe("new-tok");
    expect(result.usage?.windows.find((w) => w.kind === "week_all_models")?.usedPercent).toBe(36);
    expect(getAccount(account.id)?.usage_windows).toContain("week_all_models");
  }, 60_000);

  test("flags needs_reauth when the CLI shows the login screen", async () => {
    const account = createAccount({ name: "Dead refresh" });
    seedAccountCredentials(account.id, { accessToken: "old-tok", expiresAt: Date.now() - 1_000 });
    process.env.CLAUDE_CODE_LOGIN_COMMAND = "printf 'Select login method:\\n'; sleep 30";

    await expect(probeAccount(account.id, "manual")).rejects.toThrow(/refresh token is dead/);
    expect(getAccount(account.id)?.needs_reauth).toBe(1);
  }, 60_000);

  test("valid_noop when the token is unchanged, then safety_window is skipped by cooldown", async () => {
    const account = createAccount({ name: "Noop" });
    seedAccountCredentials(account.id, { accessToken: "same-tok", expiresAt: FUTURE });
    process.env.CLAUDE_CODE_LOGIN_COMMAND = fakeRefreshCli("same-tok", FUTURE);

    const first = await probeAccount(account.id, "manual");
    expect(first.outcome).toBe("valid_noop");

    const second = await probeAccount(account.id, "safety_window");
    expect(second.outcome).toBe("skipped_cooldown");
  }, 60_000);

  test("concurrent probes share one in-flight run", async () => {
    const account = createAccount({ name: "Dedup" });
    seedAccountCredentials(account.id, { accessToken: "old-tok", expiresAt: Date.now() - 1_000 });
    process.env.CLAUDE_CODE_LOGIN_COMMAND = fakeRefreshCli("dedup-tok", FUTURE);

    const [a, b] = await Promise.all([probeAccount(account.id, "manual"), probeAccount(account.id, "manual")]);
    expect(a).toBe(b); // same promise result — deduped, one CLI boot
    expect(a.outcome).toBe("refreshed");
  }, 60_000);
});

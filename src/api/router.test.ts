import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-router-test-${process.pid}.db`;
const claudeConfigDir = `/tmp/cc-lb-router-claude-${process.pid}`;
const accountsDir = `/tmp/cc-lb-router-accounts-${process.pid}`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
rmSync(claudeConfigDir, { force: true, recursive: true });
rmSync(accountsDir, { force: true, recursive: true });
process.env.DB_PATH = dbPath;
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;

const { appRouter } = await import("./router");
const { createAccount, deleteAccount, listAccounts, updateAccount } = await import("../db/accounts");
const { logRequest, updateRequestLogUsage } = await import("../db/request-log");
const { resetClaudeCodeLoginSessionsForTests } = await import("../anthropic/claude-code-cli");
const { resetProbeStateForTests } = await import("../anthropic/account-probe");
const { seedAccountCredentials } = await import("../testing/seed-credentials");

const caller = appRouter.createCaller({ req: new Request("http://cc-lb.test") });

// bun runs test files in one process sharing the db singleton; start from a
// clean slate and re-assert our accounts dir so absolute counts hold regardless
// of what other test files left behind.
beforeAll(() => {
  process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;
  for (const existing of listAccounts()) deleteAccount(existing.id);
});

afterAll(async () => {
  resetClaudeCodeLoginSessionsForTests();
  await resetProbeStateForTests();
  delete process.env.CLAUDE_CODE_LOGIN_COMMAND;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_ACCOUNTS_DIR;
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  rmSync(claudeConfigDir, { force: true, recursive: true });
  rmSync(accountsDir, { force: true, recursive: true });
});

describe("appRouter accounts", () => {
  test("returns public account status from credentials + rate-limit state", async () => {
    const now = Date.now();
    const healthy = createAccount({ name: "Healthy", priority: 0 });
    seedAccountCredentials(healthy.id, { accessToken: "access-a", refreshToken: "refresh-a", expiresAt: now + 3_600_000 });
    const limited = createAccount({ name: "Rate limited", priority: 1 });
    seedAccountCredentials(limited.id, { accessToken: "access-b", refreshToken: "refresh-b", expiresAt: now + 3_600_000 });
    updateAccount(limited.id, {
      rate_limited_until: now + 60_000,
      rate_limit_status: "rate_limited",
      rate_limit_remaining: 0,
      rate_limit_reset: now + 60_000,
    });
    // No credentials file → needs_reauth.
    createAccount({ name: "Needs reauth", priority: 2 });

    const accounts = await caller.accounts.list();
    expect(accounts.map((account) => account.name)).toEqual(["Healthy", "Rate limited", "Needs reauth"]);
    expect(accounts.find((account) => account.name === "Healthy")?.status).toBe("active");
    expect(accounts.find((account) => account.name === "Rate limited")?.status).toBe("rate_limited");
    const reauth = accounts.find((account) => account.name === "Needs reauth");
    expect(reauth?.status).toBe("needs_reauth");
    expect(reauth?.needsReauth).toBe(true);
  });

  test("stats count account states from public status mapping", async () => {
    const stats = await caller.stats();
    expect(stats.totalAccounts).toBe(3);
    expect(stats.availableAccounts).toBe(1);
    expect(stats.rateLimitedAccounts).toBe(1);
    expect(stats.needsReauthAccounts).toBe(1);
  });

  test("update toggles pause state and pause reason", async () => {
    const account = createAccount({ name: "Pause me" });
    seedAccountCredentials(account.id, { accessToken: "access-c", refreshToken: "refresh-c" });

    const paused = await caller.accounts.update({
      id: account.id,
      paused: true,
      pauseReason: "maintenance",
    });
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("maintenance");

    const resumed = await caller.accounts.update({ id: account.id, paused: false });
    expect(resumed.status).toBe("active");
    expect(resumed.pauseReason).toBeNull();
  });

  test("adds Claude Code accounts through the CLI login flow and updates device override", async () => {
    process.env.CLAUDE_CODE_LOGIN_COMMAND =
      "test \"$CLAUDE_CODE_NO_FLICKER\" = '0' || exit 42; printf 'Choose the text style that looks best with your terminal\\n'; read theme; printf 'Select login method:\\n'; read method; printf 'https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=router\\nPaste code here if prompted > '; read code; printf '\\nSecurity notes:\\nPress Enter to continue...\\n'; read security; printf '\\nQuick safety check: Is this a project you created or one you trust?\\n1. Yes, I trust this folder\\nEnter to confirm\\n'; read trust; mkdir -p \"$CLAUDE_CONFIG_DIR\"; printf '%s' '{\"claudeAiOauth\":{\"accessToken\":\"access-router\",\"refreshToken\":\"refresh-router\",\"expiresAt\":1800000000000,\"scopes\":[\"user:inference\"]}}' > \"$CLAUDE_CONFIG_DIR/.credentials.json\"; printf '\\nWelcome back Router!\\nTips for getting started\\n'; sleep 30";

    const login = await caller.accounts.claudeCodeLoginBegin();
    expect(login.authUrl).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=router");
    expect(login.tmuxAttachCommand).toContain("tmux -S '/tmp/cc-lb-claude-code.tmux' attach -t 'cc-lb-claude-");
    const status = await caller.accounts.claudeCodeLoginStatus({ sessionId: login.sessionId });
    expect(status.output).toContain("Paste code here if prompted");
    expect(status.tmuxAttachCommand).toBe(login.tmuxAttachCommand);

    const account = await caller.accounts.claudeCodeLoginComplete({
      sessionId: login.sessionId,
      code: "router-code",
      name: "Claude Code CLI",
      deviceIdOverride: "device-a",
    });
    expect(account.authType).toBe("oauth_refresh");
    expect(account.needsReauth).toBe(false);
    expect(account.deviceIdOverride).toBe("device-a");
    expect(account.status).toBe("active");

    const updated = await caller.accounts.update({ id: account.id, deviceIdOverride: "" });
    expect(updated.deviceIdOverride).toBeNull();
  });
});

describe("appRouter requests", () => {
  test("lists request logs with filters and options", async () => {
    const account = createAccount({ name: "Request owner" });
    const now = Date.now();
    const id = logRequest({
      accountId: account.id,
      ts: now,
      status: 200,
      model: "claude-router-unique",
      outcome: "ok",
      method: "POST",
      path: "/v1/messages",
      latencyMs: 9,
      rawRequestHeaders: "{\"method\":\"POST\"}",
      rawRequestBody: "{\"model\":\"claude-router-unique\"}",
    });
    updateRequestLogUsage(id, {
      inputTokens: 11,
      outputTokens: 13,
      costUsd: 0.002,
      upstreamRequestId: "req_router",
      totalMs: 17,
      rawResponseHeaders: "{\"status\":200}",
      rawResponseBody: "{\"usage\":{\"input_tokens\":11}}",
    });
    logRequest({
      accountId: null,
      ts: now - 1000,
      status: 503,
      model: "claude-router-other",
      outcome: "network_error",
      method: "POST",
      path: "/v1/messages/count_tokens",
      error: "dial failed",
    });

    const page = await caller.requests.list({
      accountId: account.id,
      model: "claude-router-unique",
      search: "messages",
      limit: 1,
      offset: 0,
    });

    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.entries[0]).toMatchObject({
      accountId: account.id,
      accountName: "Request owner",
      model: "claude-router-unique",
      outcome: "ok",
      inputTokens: 11,
      outputTokens: 13,
      costUsd: 0.002,
      upstreamRequestId: "req_router",
      rawRequestBody: "{\"model\":\"claude-router-unique\"}",
      rawResponseBody: "{\"usage\":{\"input_tokens\":11}}",
    });

    const options = await caller.requests.options();
    expect(options.accounts).toContainEqual({ id: account.id, name: "Request owner" });
    expect(options.models).toContain("claude-router-unique");
    expect(options.outcomes).toContain("network_error");
  });
});

describe("appRouter settings", () => {
  test("updates raw HTTP logging setting", async () => {
    const updated = await caller.settings.update({ rawHttpLoggingEnabled: true });
    expect(updated.rawHttpLoggingEnabled).toBe(true);
    const settings = await caller.settings.get();
    expect(settings.rawHttpLoggingEnabled).toBe(true);
    await caller.settings.update({ rawHttpLoggingEnabled: false });
  });

  test("updates and clears the user-agent override", async () => {
    const updated = await caller.settings.update({ userAgentOverride: "  claude-cli/2.0.14 (external, cli)  " });
    expect(updated.userAgentOverride).toBe("claude-cli/2.0.14 (external, cli)");
    const cleared = await caller.settings.update({ userAgentOverride: "" });
    expect(cleared.userAgentOverride).toBe("");
  });
});

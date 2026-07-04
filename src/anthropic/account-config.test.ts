import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = `/tmp/cc-lb-account-config-${process.pid}`;
process.env.CLAUDE_ACCOUNTS_DIR = root;

const {
  accountConfigDir,
  accountCredentialsPath,
  accountDeviceId,
  accountHasCredentials,
  accountRealUuid,
  accountTokenExpiry,
  accountWorkspaceDir,
  adoptLoginConfigDir,
  deleteAccountConfigDir,
  ensureAccountWorkspace,
  readCredentialsFile,
} = await import("./account-config");

function writeCreds(accountId: string, body: unknown): void {
  mkdirSync(accountConfigDir(accountId), { recursive: true });
  writeFileSync(accountCredentialsPath(accountId), typeof body === "string" ? body : JSON.stringify(body));
}

function writeClaudeJson(accountId: string, body: unknown): void {
  mkdirSync(accountConfigDir(accountId), { recursive: true });
  writeFileSync(join(accountConfigDir(accountId), ".claude.json"), typeof body === "string" ? body : JSON.stringify(body));
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readCredentialsFile", () => {
  test("parses a Claude-shaped credentials file", () => {
    writeCreds("a", { claudeAiOauth: { accessToken: "acc", refreshToken: "ref", expiresAt: 123, scopes: ["x", "y"] } });
    expect(readCredentialsFile("a")).toEqual({ accessToken: "acc", refreshToken: "ref", expiresAt: 123, scopes: "x y" });
  });

  test("returns null for a missing file", () => {
    expect(readCredentialsFile("missing")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    writeCreds("bad", "{ not json");
    expect(readCredentialsFile("bad")).toBeNull();
  });

  test("returns null when the oauth shape is wrong", () => {
    writeCreds("wrong", { claudeAiOauth: { accessToken: "" } });
    expect(readCredentialsFile("wrong")).toBeNull();
  });

  test("expiresAt is optional", () => {
    writeCreds("noexp", { claudeAiOauth: { accessToken: "acc", refreshToken: "ref" } });
    expect(readCredentialsFile("noexp")?.expiresAt).toBeNull();
  });
});

describe("accountTokenExpiry / accountHasCredentials", () => {
  test("reports expiry and presence", () => {
    writeCreds("b", { claudeAiOauth: { accessToken: "acc", refreshToken: "ref", expiresAt: 999 } });
    expect(accountTokenExpiry("b")).toBe(999);
    expect(accountHasCredentials("b")).toBe(true);
  });

  test("no file → null expiry, absent", () => {
    expect(accountTokenExpiry("nope")).toBeNull();
    expect(accountHasCredentials("nope")).toBe(false);
  });
});

describe("ensureAccountWorkspace", () => {
  test("creates the workspace dir", () => {
    ensureAccountWorkspace("c");
    expect(existsSync(accountWorkspaceDir("c"))).toBe(true);
  });
});

describe("adoptLoginConfigDir", () => {
  test("copies a login dir into the account dir and makes a workspace", () => {
    const source = `${root}-login`;
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "acc", refreshToken: "ref", expiresAt: 5 } }));
    writeFileSync(join(source, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));

    adoptLoginConfigDir("d", source);

    expect(readCredentialsFile("d")).toEqual({ accessToken: "acc", refreshToken: "ref", expiresAt: 5, scopes: null });
    expect(existsSync(join(accountConfigDir("d"), ".claude.json"))).toBe(true);
    expect(existsSync(accountWorkspaceDir("d"))).toBe(true);
    rmSync(source, { recursive: true, force: true });
  });

  test("no-op when the source is missing", () => {
    adoptLoginConfigDir("e", `${root}-does-not-exist`);
    expect(accountHasCredentials("e")).toBe(false);
  });
});

describe("deleteAccountConfigDir", () => {
  test("removes the account dir", () => {
    writeCreds("f", { claudeAiOauth: { accessToken: "acc", refreshToken: "ref" } });
    expect(existsSync(accountConfigDir("f"))).toBe(true);
    deleteAccountConfigDir("f");
    expect(existsSync(accountConfigDir("f"))).toBe(false);
  });
});

describe("accountDeviceId / accountRealUuid", () => {
  test("reads machineID and accountUuid from .claude.json", () => {
    writeClaudeJson("g", { machineID: "machine-123", accountUuid: "acct-uuid-9", userID: "user-abc" });
    expect(accountDeviceId("g")).toBe("machine-123");
    expect(accountRealUuid("g")).toBe("acct-uuid-9");
  });

  test("null when .claude.json is absent or lacks the field", () => {
    expect(accountDeviceId("no-json")).toBeNull();
    expect(accountRealUuid("no-json")).toBeNull();
    writeClaudeJson("h", { userID: "user-only" });
    expect(accountDeviceId("h")).toBeNull();
    expect(accountRealUuid("h")).toBeNull();
  });

  test("caches are cleared when the dir is deleted", () => {
    writeClaudeJson("i", { machineID: "machine-i", accountUuid: "uuid-i" });
    expect(accountDeviceId("i")).toBe("machine-i");
    expect(accountRealUuid("i")).toBe("uuid-i");
    deleteAccountConfigDir("i");
    expect(accountDeviceId("i")).toBeNull();
    expect(accountRealUuid("i")).toBeNull();
  });
});

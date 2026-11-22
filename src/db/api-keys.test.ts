import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-api-keys-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const {
  apiKeyBlocksModel,
  createApiKey,
  getApiKey,
  hashApiKeySecret,
  listApiKeys,
  regenerateApiKey,
  updateApiKey,
  validateApiKeySecret,
} = await import("./api-keys");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("api key repository", () => {
  test("stores only a hash, validates secrets, and updates last used", () => {
    const now = Date.now();
    const name = `Primary ${process.pid} ${now}`;
    const created = createApiKey(
      {
        name,
        allowed_models: ["claude-sonnet-4"],
        traffic_class: "interactive",
        account_scope_enabled: 1,
        assigned_account_ids: ["acct-a"],
      },
      now,
    );

    expect(created.apiKey.prefix).toStartWith("sk-");
    expect(created.plaintextKey).toStartWith(`${created.apiKey.prefix}_`);
    expect(created.apiKey.allowed_models).toEqual(["claude-sonnet-4"]);
    expect(created.apiKey.assigned_account_ids).toEqual(["acct-a"]);
    expect("keyHash" in created.apiKey).toBe(false);
    expect(hashApiKeySecret(created.plaintextKey)).not.toBe(created.plaintextKey);

    const invalid = validateApiKeySecret("bad-key", now + 1);
    expect(invalid.reason).toBe("invalid");
    expect(invalid.ok).toBe(false);

    const valid = validateApiKeySecret(created.plaintextKey, now + 2);
    expect(valid.ok).toBe(true);
    expect(valid.apiKey?.id).toBe(created.apiKey.id);
    expect(getApiKey(created.apiKey.id)?.last_used_at).toBe(now + 2);

    const listed = listApiKeys();
    const listedKey = listed.find((key) => key.id === created.apiKey.id);
    expect(listedKey?.name).toBe(name);
    expect(listedKey).toBeDefined();
    expect(listedKey && "keyHash" in listedKey).toBe(false);
  });

  test("rejects inactive and expired keys and regeneration invalidates the old secret", () => {
    const now = Date.now();
    const inactive = createApiKey({ name: "Inactive", status: "inactive" }, now);
    expect(validateApiKeySecret(inactive.plaintextKey, now + 1).reason).toBe("inactive");

    const expired = createApiKey({ name: "Expired", expires_at: now - 1 }, now);
    expect(validateApiKeySecret(expired.plaintextKey, now + 1).reason).toBe("expired");

    const active = createApiKey({ name: "Rotate" }, now);
    const rotated = regenerateApiKey(active.apiKey.id, now + 10);
    expect(rotated?.plaintextKey).not.toBe(active.plaintextKey);
    expect(rotated?.apiKey.prefix).toStartWith("sk-");
    expect(rotated?.plaintextKey).toStartWith(`${rotated?.apiKey.prefix}_`);
    expect(validateApiKeySecret(active.plaintextKey, now + 11).reason).toBe("invalid");
    expect(validateApiKeySecret(rotated?.plaintextKey ?? "", now + 12).ok).toBe(true);

    const updated = updateApiKey(active.apiKey.id, {
      status: "inactive",
      allowed_models: null,
      account_scope_enabled: 0,
      assigned_account_ids: [],
    });
    expect(updated?.status).toBe("inactive");
    expect(updated?.allowed_models).toBeNull();
  });

  test("stores a model blocklist matching exact ids and trailing wildcards", () => {
    const created = createApiKey({
      name: "Blocklist",
      blocked_models: [" claude-fable-5-2 ", "claude-fable-5-2", "claude-opus-*"],
    });
    const apiKey = created.apiKey;
    expect(apiKey.blocked_models).toEqual(["claude-fable-5-2", "claude-opus-*"]);
    expect(getApiKey(apiKey.id)?.blocked_models).toEqual(["claude-fable-5-2", "claude-opus-*"]);

    expect(apiKeyBlocksModel(apiKey, "claude-fable-5-2")).toBe(true);
    expect(apiKeyBlocksModel(apiKey, " Claude-Fable-5-2 ")).toBe(true);
    // An exact entry is not a prefix: dated variants need a wildcard entry.
    expect(apiKeyBlocksModel(apiKey, "claude-fable-5-2-20261101")).toBe(false);
    expect(apiKeyBlocksModel(apiKey, "claude-opus-5-5")).toBe(true);
    expect(apiKeyBlocksModel(apiKey, "claude-opus-4-8-20260101")).toBe(true);
    expect(apiKeyBlocksModel(apiKey, "claude-sonnet-5-5")).toBe(false);
    expect(apiKeyBlocksModel(apiKey, null)).toBe(false);

    // Patches that omit the blocklist leave it alone; an empty list clears it.
    expect(updateApiKey(apiKey.id, { name: "Renamed" })?.blocked_models).toEqual(["claude-fable-5-2", "claude-opus-*"]);
    const cleared = updateApiKey(apiKey.id, { blocked_models: [] });
    expect(cleared?.blocked_models).toEqual([]);
    expect(cleared && apiKeyBlocksModel(cleared, "claude-fable-5-2")).toBe(false);
    expect(createApiKey({ name: "No blocklist" }).apiKey.blocked_models).toEqual([]);
  });
});

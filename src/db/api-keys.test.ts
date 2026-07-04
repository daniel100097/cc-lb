import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-api-keys-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const {
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
});

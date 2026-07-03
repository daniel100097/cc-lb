import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-proxy-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { createAccount, listAccounts, updateAccount } = await import("../db/accounts");
const { listRequests } = await import("../db/request-log");
const { getSticky, setSticky } = await import("../db/sticky");
const { handleProxy } = await import("./handler");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("handleProxy", () => {
  test("logs telemetry short-circuits", async () => {
    const response = await handleProxy(
      new Request("http://cc-lb.test/api/event_logging/batch", { method: "POST" }),
      new URL("http://cc-lb.test/api/event_logging/batch"),
    );
    expect(response.status).toBe(200);
    const logs = listRequests({ limit: 10, offset: 0, outcome: "telemetry" });
    expect(logs.total).toBe(1);
    expect(logs.entries[0]?.path).toBe("/api/event_logging/batch");
  });

  test("fallback success does not overwrite unavailable sticky home", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const home = createAccount({
      name: "Home",
      access_token: "home-access",
      refresh_token: "home-refresh",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 0,
    });
    const fallback = createAccount({
      name: "Fallback",
      access_token: "fallback-access",
      refresh_token: "fallback-refresh",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 1,
    });
    updateAccount(home.id, { rate_limited_until: now + 60_000 });
    setSticky("session-abc", home.id, now);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        Response.json(
          { usage: { input_tokens: 1, output_tokens: 2 } },
          { headers: { "content-type": "application/json", "anthropic-billing-cost": "0.004" } },
        ),
      { preconnect: globalThis.fetch.preconnect },
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cc-session-id": "session-abc",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model: "claude-handler-unique", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getSticky("session-abc", 60_000, Date.now())).toBe(home.id);
      const logs = listRequests({ limit: 10, offset: 0, search: "claude-handler-unique" });
      expect(logs.total).toBe(1);
      expect(logs.entries[0]?.account_id).toBe(fallback.id);
      expect(logs.entries[0]?.model).toBe("claude-handler-unique");
      expect(logs.entries[0]?.input_tokens).toBe(1);
      expect(logs.entries[0]?.cost_usd).toBe(0.004);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

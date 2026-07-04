import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-proxy-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { createAccount, getAccount, listAccounts, updateAccount } = await import("../db/accounts");
const { DEVICE_ID_HEADER } = await import("../anthropic/headers");
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

  test("does not add account device override to requests without a device id signal", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    createAccount({
      name: "Device override inactive",
      access_token: "device-access-a",
      refresh_token: "device-refresh-a",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      device_id_override: "account-device",
    });

    const outboundHeaders: Headers[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        outboundHeaders.push(new Headers(init?.headers));
        return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-no-device", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundHeaders[0]?.get(DEVICE_ID_HEADER)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("patches body device id to the account override without adding a header", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    createAccount({
      name: "Device override active",
      access_token: "device-access-b",
      refresh_token: "device-refresh-b",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      device_id_override: "account-device",
    });

    const { headers: outboundHeaders, bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-body-device", messages: [], device_id: "client-device" }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundHeaders[0]?.get(DEVICE_ID_HEADER)).toBeNull();
      const sent = decodeBody(outboundBodies[0]);
      expect(sent.device_id).toBe("account-device");
      expect(sent.model).toBe("claude-body-device");
    } finally {
      restore();
    }
  });

  test("overrides the device id header without touching the body", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    createAccount({
      name: "Device override header only",
      access_token: "device-access-c",
      refresh_token: "device-refresh-c",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      device_id_override: "account-device",
    });

    const { headers: outboundHeaders, bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", [DEVICE_ID_HEADER]: "client-device" },
          body: JSON.stringify({ model: "claude-header-device", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundHeaders[0]?.get(DEVICE_ID_HEADER)).toBe("account-device");
      const sent = decodeBody(outboundBodies[0]);
      expect(sent.device_id).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("overrides header and body independently when both carry a device id", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    createAccount({
      name: "Device override both",
      access_token: "device-access-d",
      refresh_token: "device-refresh-d",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      device_id_override: "account-device",
    });

    const { headers: outboundHeaders, bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", [DEVICE_ID_HEADER]: "client-device" },
          body: JSON.stringify({
            model: "claude-both-device",
            messages: [{ role: "user", content: "hi", device_id: "y" }],
            metadata: { deviceId: "x" },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundHeaders[0]?.get(DEVICE_ID_HEADER)).toBe("account-device");
      const sent = decodeBody(outboundBodies[0]);
      expect(sent.metadata.deviceId).toBe("account-device");
      expect(sent.messages[0].device_id).toBe("account-device");
      expect(sent.messages[0].content).toBe("hi");
    } finally {
      restore();
    }
  });

  test("keeps the original body pristine across failover to accounts without overrides", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    createAccount({
      name: "Failover device A",
      access_token: "failover-access-a",
      refresh_token: "failover-refresh-a",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 0,
      device_id_override: "device-a",
    });
    createAccount({
      name: "Failover device B",
      access_token: "failover-access-b",
      refresh_token: "failover-refresh-b",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 1,
    });

    let call = 0;
    const { bodies: outboundBodies, restore } = captureFetch(() => {
      call += 1;
      if (call === 1) return new Response("limited", { status: 429 });
      return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-failover-device", messages: [], device_id: "client-device" }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundBodies.length).toBe(2);
      expect(decodeBody(outboundBodies[0]).device_id).toBe("device-a");
      expect(decodeBody(outboundBodies[1]).device_id).toBe("client-device");
    } finally {
      restore();
    }
  });

  test("fills account_uuid inside the metadata.user_id envelope with the routed account id", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({
      name: "Account uuid fill",
      access_token: "uuid-access-a",
      refresh_token: "uuid-refresh-a",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
    });

    const userId = JSON.stringify({
      device_id: "4c646496947b2cb162e80ccba59ec0bd84bc1e96b79d73400b036b5fa6973f59",
      account_uuid: "",
      session_id: "d9d81c35-a75c-498a-b7b8-7d1614b38280",
    });
    const { headers: outboundHeaders, bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-account-uuid", messages: [], metadata: { user_id: userId } }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      const sent = decodeBody(outboundBodies[0]);
      const sentUserId = JSON.parse(sent.metadata.user_id);
      expect(sentUserId.account_uuid).toBe(account.id);
      expect(sentUserId.device_id).toBe("4c646496947b2cb162e80ccba59ec0bd84bc1e96b79d73400b036b5fa6973f59");
      expect(sentUserId.session_id).toBe("d9d81c35-a75c-498a-b7b8-7d1614b38280");
      expect(outboundHeaders[0]?.get(DEVICE_ID_HEADER)).toBeNull();
    } finally {
      restore();
    }
  });

  test("rewrites device_id inside the user_id envelope only when the account has an override", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({
      name: "Envelope device override",
      access_token: "uuid-access-b",
      refresh_token: "uuid-refresh-b",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      device_id_override: "account-device",
    });

    const userId = JSON.stringify({ device_id: "client-device", account_uuid: "old-uuid", session_id: "s-1" });
    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-envelope-device", messages: [], metadata: { user_id: userId } }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      const sentUserId = JSON.parse(decodeBody(outboundBodies[0]).metadata.user_id);
      expect(sentUserId.device_id).toBe("account-device");
      expect(sentUserId.account_uuid).toBe(account.id);
      expect(sentUserId.session_id).toBe("s-1");
    } finally {
      restore();
    }
  });

  test("patches bare account_uuid fields and leaves plain user_id strings untouched", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({
      name: "Bare account uuid",
      access_token: "uuid-access-c",
      refresh_token: "uuid-refresh-c",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
    });

    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-bare-uuid",
            messages: [],
            account_uuid: "",
            metadata: { user_id: "session_abc123" },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      const sent = decodeBody(outboundBodies[0]);
      expect(sent.account_uuid).toBe(account.id);
      expect(sent.metadata.user_id).toBe("session_abc123");
    } finally {
      restore();
    }
  });

  test("patches account_uuid per attempt so each failover account sends its own id", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const first = createAccount({
      name: "Uuid failover A",
      access_token: "uuid-failover-a",
      refresh_token: "uuid-failover-ra",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 0,
    });
    const second = createAccount({
      name: "Uuid failover B",
      access_token: "uuid-failover-b",
      refresh_token: "uuid-failover-rb",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 1,
    });

    let call = 0;
    const { bodies: outboundBodies, restore } = captureFetch(() => {
      call += 1;
      if (call === 1) return new Response("limited", { status: 429 });
      return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-uuid-failover",
            messages: [],
            metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: "s" }) },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundBodies.length).toBe(2);
      expect(JSON.parse(decodeBody(outboundBodies[0]).metadata.user_id).account_uuid).toBe(first.id);
      expect(JSON.parse(decodeBody(outboundBodies[1]).metadata.user_id).account_uuid).toBe(second.id);
    } finally {
      restore();
    }
  });

  test("fails over on out_of_credits without benching the account", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const creditless = createAccount({
      name: "Out of credits",
      access_token: "credits-access-a",
      refresh_token: "credits-refresh-a",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 0,
    });
    const fallback = createAccount({
      name: "Credits fallback",
      access_token: "credits-access-b",
      refresh_token: "credits-refresh-b",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
      priority: 1,
    });

    let call = 0;
    const { restore } = captureFetch(() => {
      call += 1;
      if (call === 1) {
        return new Response("limited", {
          status: 429,
          headers: { "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" },
        });
      }
      return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-out-of-credits", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const benched = getAccount(creditless.id);
      expect(benched?.rate_limited_until).toBeNull();
      expect(benched?.consecutive_rate_limits).toBe(0);

      const logs = listRequests({ limit: 10, offset: 0, search: "claude-out-of-credits" });
      const creditlessEntry = logs.entries.find((entry) => entry.account_id === creditless.id);
      const fallbackEntry = logs.entries.find((entry) => entry.account_id === fallback.id);
      expect(creditlessEntry?.outcome).toBe("rate_limited");
      expect(fallbackEntry?.outcome).toBe("ok");
    } finally {
      restore();
    }
  });

  test("pool_exhausted names reauth accounts and points at the dashboard", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const reauth = createAccount({
      name: "Needs reauth pool",
      access_token: "reauth-access",
      refresh_token: "reauth-refresh",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
    });
    updateAccount(reauth.id, { needs_reauth: 1 });

    const response = await handleProxy(
      new Request("http://cc-lb.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-pool-reauth", messages: [] }),
      }),
      new URL("http://cc-lb.test/v1/messages"),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("pool_exhausted");
    expect(body.message).toContain("Needs reauth pool");
    expect(body.message).toContain("http://localhost:8484");
    expect(body.message).toContain("Re-authenticate");
  });

  test("pool_exhausted omits the reauth message for rate-limited pools", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const limited = createAccount({
      name: "Rate limited pool",
      access_token: "limited-access",
      refresh_token: "limited-refresh",
      expires_at: now + 3_600_000,
      refresh_token_issued_at: now,
    });
    updateAccount(limited.id, { rate_limited_until: now + 60_000 });

    const response = await handleProxy(
      new Request("http://cc-lb.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-pool-limited", messages: [] }),
      }),
      new URL("http://cc-lb.test/v1/messages"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
    const body = await response.json();
    expect(body.message).toBeUndefined();
  });
});

function captureFetch(respond: () => Response) {
  const headers: Headers[] = [];
  const bodies: (BodyInit | null | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      bodies.push(init?.body);
      return respond();
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return {
    headers,
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function decodeBody(body: BodyInit | null | undefined) {
  if (!(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
    throw new Error("expected binary outbound body");
  }
  return JSON.parse(new TextDecoder().decode(body));
}

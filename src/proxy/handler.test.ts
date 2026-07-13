import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dbPath = `/tmp/cc-lb-proxy-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;
const accountsDir = `/tmp/cc-lb-proxy-accounts-${process.pid}`;
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;

const { createAccount, getAccount, listAccounts, updateAccount } = await import("../db/accounts");
const { installedClaudeVersion } = await import("../anthropic/claude-version");
const { DEVICE_ID_HEADER } = await import("../anthropic/headers");
const { listRequests } = await import("../db/request-log");
const { patchSettings } = await import("../db/settings");
const { blockStickySessions, claimSticky, getSticky, getStickyIdentity } = await import("../db/sticky");
const { handleProxy: handleProxyRequest } = await import("./handler");
const { seedAccountCredentials } = await import("../testing/seed-credentials");
const { accountConfigDir } = await import("../anthropic/account-config");

const installedVersion = installedClaudeVersion();
if (!installedVersion) throw new Error("Claude Code test dependency is missing");
const installedUserAgent = `claude-cli/${installedVersion} (external, cli)`;
let sessionSequence = 0;

function handleProxy(req: Request, url: URL): Promise<Response> {
  const headers = new Headers(req.headers);
  const sessionId = headers.get("x-claude-code-session-id") ?? `handler-test-${process.pid}-${++sessionSequence}`;
  headers.set("x-claude-code-session-id", sessionId);
  if (!headers.has("user-agent")) headers.set("user-agent", installedUserAgent);
  return handleProxyRequest(new Request(req, { headers }), url);
}

function writeAccountClaudeJson(accountId: string, body: Record<string, unknown>): void {
  mkdirSync(accountConfigDir(accountId), { recursive: true });
  writeFileSync(join(accountConfigDir(accountId), ".claude.json"), JSON.stringify(body));
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  rmSync(accountsDir, { recursive: true, force: true });
});

describe("handleProxy", () => {
  test("logs telemetry short-circuits", async () => {
    const response = await handleProxyRequest(
      new Request("http://cc-lb.test/api/event_logging/batch", { method: "POST" }),
      new URL("http://cc-lb.test/api/event_logging/batch"),
    );
    expect(response.status).toBe(200);
    const logs = listRequests({ limit: 10, offset: 0, outcome: "telemetry" });
    expect(logs.total).toBe(1);
    expect(logs.entries[0]?.path).toBe("/api/event_logging/batch");
    expect(logs.entries[0]?.raw_request_headers).toBeNull();
    expect(logs.entries[0]?.raw_upstream_request_headers).toBeNull();
    expect(logs.entries[0]?.raw_response_body).toBeNull();
  });

  test("rejects requests without the official Claude Code session header", async () => {
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    const cases = [
      new Headers({ "user-agent": installedUserAgent }),
      new Headers({ "user-agent": installedUserAgent, "x-claude-code-session-id": "   " }),
      new Headers({ "user-agent": installedUserAgent, "x-cc-session-id": "alias-only" }),
    ];

    try {
      for (const headers of cases) {
        const response = await handleProxyRequest(
          new Request("http://cc-lb.test/v1/messages", {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: "claude-rejected-session",
              messages: [],
              metadata: { user_id: JSON.stringify({ session_id: "metadata-only" }) },
            }),
          }),
          new URL("http://cc-lb.test/v1/messages"),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("claude_code_required");
      }
      expect(inits).toHaveLength(0);
      expect(getSticky("sid:alias-only")).toBeNull();
      expect(getSticky("sid:metadata-only")).toBeNull();
      expect(listRequests({ limit: 10, offset: 0, search: "claude-rejected-session" }).total).toBe(0);
    } finally {
      restore();
    }
  });

  test("rejects Claude Code versions that do not match the server", async () => {
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    const userAgents = [null, "curl/8.0", "claude-cli/0.0.0 (external, cli)"];

    try {
      for (const userAgent of userAgents) {
        const headers = new Headers({ "x-claude-code-session-id": "wrong-version" });
        if (userAgent) headers.set("user-agent", userAgent);
        const response = await handleProxyRequest(
          new Request("http://cc-lb.test/v1/messages", {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-rejected-version", messages: [] }),
          }),
          new URL("http://cc-lb.test/v1/messages"),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("claude_code_version_mismatch");
      }
      expect(inits).toHaveLength(0);
      expect(getSticky("sid:wrong-version")).toBeNull();
      expect(listRequests({ limit: 10, offset: 0, search: "claude-rejected-version" }).total).toBe(0);
    } finally {
      restore();
    }
  });

  test("rejects assistant history for a session the load balancer has never seen", async () => {
    const sessionId = `unknown-history-${process.pid}`;
    const model = "claude-unknown-history";
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
          body: JSON.stringify({
            model,
            messages: [
              { role: "user", content: "first" },
              { role: "assistant", content: "existing history" },
              { role: "user", content: "continued" },
            ],
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("unknown_session_history");
      expect(inits).toHaveLength(0);
      expect(getSticky(`sid:${sessionId}`)).toBeNull();
      expect(listRequests({ limit: 10, offset: 0, search: model }).total).toBe(0);
    } finally {
      restore();
    }
  });

  test("rejects duplicate or uninspectable JSON without admitting the session", async () => {
    const cases = [
      {
        sessionId: `duplicate-messages-${process.pid}`,
        body:
          '{"model":"claude-duplicate-messages","messages":[{"role":"assistant","content":"old"}],' +
          '"messages":[{"role":"user","content":"new"}]}',
        error: "ambiguous_claude_request_body",
      },
      {
        sessionId: `duplicate-envelope-${process.pid}`,
        body: JSON.stringify({
          model: "claude-duplicate-envelope",
          messages: [{ role: "user", content: "new" }],
          metadata: {
            user_id:
              '{"account_uuid":"old-account","account_uuid":"clean-account",' +
              `"session_id":"duplicate-envelope-${process.pid}"}`,
          },
        }),
        error: "ambiguous_claude_request_body",
      },
      {
        sessionId: `invalid-json-${process.pid}`,
        body: '{"model":"claude-invalid-json","messages":[',
        error: "invalid_claude_request_body",
      },
    ];
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));

    try {
      for (const item of cases) {
        const response = await handleProxy(
          new Request("http://cc-lb.test/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-claude-code-session-id": item.sessionId,
            },
            body: item.body,
          }),
          new URL("http://cc-lb.test/v1/messages"),
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(item.error);
        expect(getSticky(`sid:${item.sessionId}`)).toBeNull();
      }
      expect(inits).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("quota preflight stays pending until a clean substantive message admits the same account", async () => {
    const now = Date.now();
    for (const account of listAccounts()) updateAccount(account.id, { paused: 1 });
    const home = createAccount({
      name: "Quota pending home",
      priority: 0,
    });
    seedAccountCredentials(home.id, {
      accessToken: "quota-pending-home-access",
      refreshToken: "quota-pending-home-refresh",
      expiresAt: now + 3_600_000,
      machineId: "quota-account-device",
    });
    const other = createAccount({ name: "Quota pending other", priority: 1 });
    seedAccountCredentials(other.id, {
      accessToken: "quota-pending-other-access",
      refreshToken: "quota-pending-other-refresh",
      expiresAt: now + 3_600_000,
    });
    const sessionId = `quota-pending-${process.pid}`;
    const userId = JSON.stringify({
      account_uuid: "client-account",
      device_id: "quota-client-device",
      session_id: sessionId,
    });
    const headers = {
      "content-type": "application/json",
      "x-claude-code-session-id": sessionId,
    };
    const { headers: outboundHeaders, inits, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const quotaResponse = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "claude-quota-pending",
            max_tokens: 1,
            messages: [{ role: "user", content: "quota" }],
            metadata: { user_id: userId },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(quotaResponse.status).toBe(200);
      await quotaResponse.text();
      expect(getStickyIdentity(`sid:${sessionId}`)).toEqual({
        accountId: home.id,
        status: "pending",
        clientDeviceId: "quota-client-device",
      });
      expect(inits).toHaveLength(1);

      updateAccount(home.id, { priority: 10 });
      updateAccount(other.id, { priority: 0 });
      const historyResponse = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "claude-quota-history",
            messages: [
              { role: "user", content: "old question" },
              { role: "assistant", content: "old answer" },
            ],
            metadata: { user_id: userId },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(historyResponse.status).toBe(403);
      expect((await historyResponse.json()).error).toBe("unknown_session_history");
      expect(inits).toHaveLength(1);
      expect(getStickyIdentity(`sid:${sessionId}`)?.status).toBe("pending");

      const cleanResponse = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "claude-quota-clean",
            messages: [{ role: "user", content: "new question" }],
            metadata: { user_id: userId },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(cleanResponse.status).toBe(200);
      await cleanResponse.text();
      expect(getStickyIdentity(`sid:${sessionId}`)).toEqual({
        accountId: home.id,
        status: "active",
        clientDeviceId: "quota-client-device",
      });
      expect(inits).toHaveLength(2);
      expect(outboundHeaders.every((entry) => entry.get("authorization") === "Bearer quota-pending-home-access")).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  test("allows assistant history after the session already has a permanent binding", async () => {
    const now = Date.now();
    for (const account of listAccounts()) updateAccount(account.id, { paused: 1 });
    const account = createAccount({ name: "Known history owner" });
    seedAccountCredentials(account.id, {
      accessToken: "known-history-access",
      refreshToken: "known-history-refresh",
      expiresAt: now + 3_600_000,
    });
    const sessionId = `known-history-${process.pid}`;
    claimSticky(`sid:${sessionId}`, account.id, now);
    const { restore } = captureFetch(() => Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }));
    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
          body: JSON.stringify({
            model: "claude-known-history",
            messages: [
              { role: "user", content: "first" },
              { role: "assistant", content: "existing history" },
              { role: "user", content: "continued" },
            ],
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(getSticky(`sid:${sessionId}`)).toEqual({ accountId: account.id, status: "active" });
    } finally {
      restore();
    }
  });

  test("permanently rejects an operator-blocked session without trying another account", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const home = createAccount({ name: "Blocked home", priority: 0 });
    seedAccountCredentials(home.id, {
      accessToken: "blocked-home-access",
      refreshToken: "blocked-home-refresh",
      expiresAt: now + 3_600_000,
    });
    const other = createAccount({ name: "Blocked other", priority: 1 });
    seedAccountCredentials(other.id, {
      accessToken: "blocked-other-access",
      refreshToken: "blocked-other-refresh",
      expiresAt: now + 3_600_000,
    });
    claimSticky("sid:operator-blocked", home.id, now - 1_000);
    expect(blockStickySessions(["sid:operator-blocked"], now)).toBe(1);

    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": "operator-blocked",
          },
          body: JSON.stringify({ model: "claude-operator-blocked", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("session_blocked");
      expect(inits).toHaveLength(0);
      expect(getSticky("sid:operator-blocked")).toEqual({ accountId: home.id, status: "blocked" });
      expect(claimSticky("sid:operator-blocked", other.id, now + 1_000)).toEqual({
        accountId: home.id,
        status: "blocked",
      });
      expect(listRequests({ limit: 10, offset: 0, search: "claude-operator-blocked" }).total).toBe(0);
    } finally {
      restore();
    }
  });

  test("rejects a pinned account that is missing its real accountUuid", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const missing = createAccount({ name: "Missing account identity", priority: 0 });
    seedAccountCredentials(missing.id, {
      accessToken: "missing-identity-access",
      refreshToken: "missing-identity-refresh",
      expiresAt: now + 3_600_000,
      accountUuid: null,
    });
    const other = createAccount({ name: "Identity fallback forbidden", priority: 1 });
    seedAccountCredentials(other.id, {
      accessToken: "identity-other-access",
      refreshToken: "identity-other-refresh",
      expiresAt: now + 3_600_000,
    });

    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": "missing-account-identity",
          },
          body: JSON.stringify({ model: "claude-missing-account-identity", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("account_identity_missing");
      expect(inits).toHaveLength(0);
      expect(getSticky("sid:missing-account-identity")).toEqual({ accountId: missing.id, status: "active" });
      expect(listRequests({ limit: 10, offset: 0, search: "claude-missing-account-identity" }).total).toBe(0);
    } finally {
      restore();
    }
  });

  test("rejects a device-bearing request when the pinned account has no device identity", async () => {
    const now = Date.now();
    for (const account of listAccounts()) updateAccount(account.id, { paused: 1 });
    const missing = createAccount({ name: "Missing device identity", priority: 0 });
    seedAccountCredentials(missing.id, {
      accessToken: "missing-device-access",
      refreshToken: "missing-device-refresh",
      expiresAt: now + 3_600_000,
    });
    const other = createAccount({ name: "Device fallback forbidden", priority: 1 });
    seedAccountCredentials(other.id, {
      accessToken: "other-device-access",
      refreshToken: "other-device-refresh",
      expiresAt: now + 3_600_000,
    });
    const sessionId = "missing-device-identity";
    const userId = JSON.stringify({ device_id: "client-device", account_uuid: "client-account", session_id: sessionId });
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
          body: JSON.stringify({ model: "claude-missing-device", messages: [], metadata: { user_id: userId } }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe("account_device_identity_missing");
      expect(inits).toHaveLength(0);
      expect(getSticky(`sid:${sessionId}`)).toEqual({ accountId: missing.id, status: "active" });
    } finally {
      restore();
    }
  });

  test("rejects an original device id leaked outside recognized identity fields", async () => {
    const originalDeviceId = "client-device-fingerprint-0123456789";
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));
    try {
      const cases: Array<{
        sessionId: string;
        extraHeaders: Record<string, string>;
        messages: Array<Record<string, string>>;
      }> = [
        {
          sessionId: "device-leak-header",
          extraHeaders: { "x-debug-device": `leaked=${originalDeviceId}` },
          messages: [{ role: "user", content: "clean prompt" }],
        },
        {
          sessionId: "device-leak-body",
          extraHeaders: {},
          messages: [{ role: "user", content: `unexpected ${originalDeviceId}` }],
        },
      ];

      for (const item of cases) {
        const userId = JSON.stringify({
          device_id: originalDeviceId,
          account_uuid: "client-account",
          session_id: item.sessionId,
        });
        const response = await handleProxy(
          new Request("http://cc-lb.test/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-claude-code-session-id": item.sessionId,
              ...item.extraHeaders,
            },
            body: JSON.stringify({
              model: `claude-${item.sessionId}`,
              messages: item.messages,
              metadata: { user_id: userId },
            }),
          }),
          new URL("http://cc-lb.test/v1/messages"),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("unexpected_device_identity");
        expect(getSticky(`sid:${item.sessionId}`)).toBeNull();
      }

      const unparsedSessionId = "device-leak-unparsed-body";
      const unparsed = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": unparsedSessionId,
            [DEVICE_ID_HEADER]: originalDeviceId,
          },
          body: `not-json ${originalDeviceId}`,
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(unparsed.status).toBe(403);
      expect((await unparsed.json()).error).toBe("unexpected_device_identity");
      expect(getSticky(`sid:${unparsedSessionId}`)).toBeNull();
      expect(inits).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("persists the first client device and rejects later device conflicts", async () => {
    const now = Date.now();
    for (const account of listAccounts()) updateAccount(account.id, { paused: 1 });
    const account = createAccount({
      name: "Durable client device",
    });
    seedAccountCredentials(account.id, {
      accessToken: "durable-device-access",
      refreshToken: "durable-device-refresh",
      expiresAt: now + 3_600_000,
      machineId: "durable-account-device",
    });
    const sessionId = `durable-device-${process.pid}`;
    const requestFor = (deviceId: string, headerDeviceId?: string) => {
      const headers = new Headers({
        "content-type": "application/json",
        "x-claude-code-session-id": sessionId,
      });
      if (headerDeviceId) headers.set(DEVICE_ID_HEADER, headerDeviceId);
      return new Request("http://cc-lb.test/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-durable-device",
          messages: [{ role: "user", content: "new message" }],
          metadata: {
            user_id: JSON.stringify({
              device_id: deviceId,
              account_uuid: "client-account",
              session_id: sessionId,
            }),
          },
        }),
      });
    };
    const { bodies: outboundBodies, inits, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const first = await handleProxy(requestFor("durable-client-device"), new URL("http://cc-lb.test/v1/messages"));
      expect(first.status).toBe(200);
      await first.text();
      expect(getStickyIdentity(`sid:${sessionId}`)).toEqual({
        accountId: account.id,
        status: "active",
        clientDeviceId: "durable-client-device",
      });
      expect(JSON.parse(decodeBody(outboundBodies[0]).metadata.user_id).device_id).toBe("durable-account-device");

      const same = await handleProxy(requestFor("durable-client-device"), new URL("http://cc-lb.test/v1/messages"));
      expect(same.status).toBe(200);
      await same.text();

      const changed = await handleProxy(requestFor("different-client-device"), new URL("http://cc-lb.test/v1/messages"));
      expect(changed.status).toBe(403);
      expect((await changed.json()).error).toBe("device_identity_mismatch");
      expect(inits).toHaveLength(2);

      const mismatchSessionId = `header-envelope-mismatch-${process.pid}`;
      const mismatch = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": mismatchSessionId,
            [DEVICE_ID_HEADER]: "header-client-device",
          },
          body: JSON.stringify({
            model: "claude-header-envelope-mismatch",
            messages: [{ role: "user", content: "new message" }],
            metadata: {
              user_id: JSON.stringify({
                device_id: "envelope-client-device",
                account_uuid: "client-account",
                session_id: mismatchSessionId,
              }),
            },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(mismatch.status).toBe(403);
      expect((await mismatch.json()).error).toBe("device_identity_mismatch");
      expect(inits).toHaveLength(2);
      expect(getSticky(`sid:${mismatchSessionId}`)).toBeNull();
    } finally {
      restore();
    }
  });

  test("rejects a stored client device leaked by later traffic without an envelope", async () => {
    const now = Date.now();
    for (const account of listAccounts()) updateAccount(account.id, { paused: 1 });
    const account = createAccount({
      name: "Stored device leak",
    });
    seedAccountCredentials(account.id, {
      accessToken: "stored-leak-access",
      refreshToken: "stored-leak-refresh",
      expiresAt: now + 3_600_000,
      machineId: "stored-leak-account-device",
    });
    const sessionId = `stored-device-leak-${process.pid}`;
    const clientDeviceId = "stored-client-device-fingerprint";
    const headers = {
      "content-type": "application/json",
      "x-claude-code-session-id": sessionId,
    };
    const { inits, restore } = captureFetch(() => Response.json({ input_tokens: 1 }));

    try {
      const first = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "claude-store-device",
            messages: [{ role: "user", content: "new message" }],
            metadata: {
              user_id: JSON.stringify({
                device_id: clientDeviceId,
                account_uuid: "client-account",
                session_id: sessionId,
              }),
            },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(first.status).toBe(200);
      await first.text();

      const leaked = await handleProxy(
        new Request("http://cc-lb.test/v1/messages/count_tokens", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: "claude-stored-device-leak",
            messages: [{ role: "user", content: `leaked ${clientDeviceId}` }],
          }),
        }),
        new URL("http://cc-lb.test/v1/messages/count_tokens"),
      );
      expect(leaked.status).toBe(403);
      expect((await leaked.json()).error).toBe("unexpected_device_identity");
      expect(inits).toHaveLength(1);
      expect(getStickyIdentity(`sid:${sessionId}`)).toEqual({
        accountId: account.id,
        status: "active",
        clientDeviceId,
      });
    } finally {
      restore();
    }
  });

  test("rejects duplicate and off-path device keys before claiming a session", async () => {
    const duplicateSessionId = `duplicate-device-key-${process.pid}`;
    const offPathSessionId = `off-path-device-key-${process.pid}`;
    const duplicateEnvelope =
      `{"device_id":"duplicate-client-device","device_id":"duplicate-client-device",` +
      `"account_uuid":"client-account","session_id":"${duplicateSessionId}"}`;
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));

    try {
      const cases = [
        {
          sessionId: duplicateSessionId,
          body: {
            model: "claude-duplicate-device-key",
            messages: [{ role: "user", content: "new message" }],
            metadata: { user_id: duplicateEnvelope },
          },
        },
        {
          sessionId: offPathSessionId,
          body: {
            model: "claude-off-path-device-key",
            messages: [{ role: "user", content: "new message" }],
            debug: { deviceId: "off-path-client-device" },
          },
        },
      ];
      for (const item of cases) {
        const response = await handleProxy(
          new Request("http://cc-lb.test/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-claude-code-session-id": item.sessionId,
            },
            body: JSON.stringify(item.body),
          }),
          new URL("http://cc-lb.test/v1/messages"),
        );
        expect(response.status).toBe(403);
        expect((await response.json()).error).toBe("unexpected_device_identity");
        expect(getSticky(`sid:${item.sessionId}`)).toBeNull();
      }
      expect(inits).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("old chat sessions never expire or fall back when their account is rate-limited", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const home = createAccount({
      name: "Home",
      priority: 0,
    });
    seedAccountCredentials(home.id, {
      accessToken: "home-access",
      refreshToken: "home-refresh",
      expiresAt: now + 3_600_000,
    });
    const fallback = createAccount({
      name: "Fallback",
      priority: 1,
    });
    seedAccountCredentials(fallback.id, {
      accessToken: "fallback-access",
      refreshToken: "fallback-refresh",
      expiresAt: now + 3_600_000,
    });
    updateAccount(home.id, { rate_limited_until: now + 60_000 });
    claimSticky("sid:session-abc", home.id, now - 7 * 24 * 60 * 60 * 1000);

    let call = 0;
    const { restore } = captureFetch(() => {
      call += 1;
      return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": "session-abc",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model: "claude-handler-unique", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).not.toBeNull();
      expect(call).toBe(0);
      expect(getSticky("sid:session-abc")).toEqual({ accountId: home.id, status: "active" });
      const body = await response.json();
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]?.id).toBe(home.id);
      const logs = listRequests({ limit: 10, offset: 0, search: "claude-handler-unique" });
      expect(logs.total).toBe(0);
    } finally {
      restore();
    }
  });

  test("new chat sessions claim one account before the first upstream attempt", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const home = createAccount({
      name: "Rate stay home",
      priority: 0,
    });
    seedAccountCredentials(home.id, {
      accessToken: "rate-stay-home-access",
      refreshToken: "rate-stay-home-refresh",
      expiresAt: now + 3_600_000,
    });
    const fallback = createAccount({
      name: "Rate stay fallback",
      priority: 1,
    });
    seedAccountCredentials(fallback.id, {
      accessToken: "rate-stay-fallback-access",
      refreshToken: "rate-stay-fallback-refresh",
      expiresAt: now + 3_600_000,
    });
    let call = 0;
    const { restore } = captureFetch(() => {
      call += 1;
      if (call === 1) return new Response("limited", { status: 429 });
      return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": "session-stay",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model: "claude-handler-stay", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).not.toBeNull();
      await response.json();
      expect(call).toBe(1);
      expect(getSticky("sid:session-stay")).toEqual({ accountId: home.id, status: "active" });
      expect(getAccount(home.id)?.rate_limited_until).not.toBeNull();
      const logs = listRequests({ limit: 10, offset: 0, search: "claude-handler-stay" });
      expect(logs.entries.find((entry) => entry.account_id === home.id)?.outcome).toBe("rate_limited");
      expect(logs.entries.some((entry) => entry.account_id === fallback.id)).toBe(false);
    } finally {
      restore();
    }
  });

  test("new chats skip accounts at or above the usage cutoff", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const hot = createAccount({ name: "Cutoff hot", priority: 0 });
    seedAccountCredentials(hot.id, {
      accessToken: "cutoff-hot-access",
      refreshToken: "cutoff-hot-refresh",
      expiresAt: now + 3_600_000,
    });
    const fresh = createAccount({ name: "Cutoff fresh", priority: 1 });
    seedAccountCredentials(fresh.id, {
      accessToken: "cutoff-fresh-access",
      refreshToken: "cutoff-fresh-refresh",
      expiresAt: now + 3_600_000,
    });
    updateAccount(hot.id, {
      usage_windows: sessionUsageWindows(96, now + 3_600_000),
      usage_checked_at: now,
    });

    const { restore } = captureFetch(() => Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }));

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "session-cutoff-new" },
          body: JSON.stringify({ model: "claude-cutoff-new", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(getSticky("sid:session-cutoff-new")).toEqual({ accountId: fresh.id, status: "active" });
      const logs = listRequests({ limit: 10, offset: 0, search: "claude-cutoff-new" });
      expect(logs.entries[0]?.account_id).toBe(fresh.id);
    } finally {
      restore();
    }
  });

  test("new chats also skip accounts above the weekly cutoff", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const weekly = createAccount({ name: "Cutoff weekly", priority: 0 });
    seedAccountCredentials(weekly.id, {
      accessToken: "cutoff-weekly-access",
      refreshToken: "cutoff-weekly-refresh",
      expiresAt: now + 3_600_000,
    });
    const fresh = createAccount({ name: "Cutoff weekly fresh", priority: 1 });
    seedAccountCredentials(fresh.id, {
      accessToken: "cutoff-weekly-fresh-access",
      refreshToken: "cutoff-weekly-fresh-refresh",
      expiresAt: now + 3_600_000,
    });
    updateAccount(weekly.id, {
      usage_windows: JSON.stringify([
        { label: "Current session", kind: "session", model: null, usedPercent: 12, resetsRaw: null, resetsAtMs: now + 3_600_000 },
        { label: "Current week (all models)", kind: "week_all_models", model: null, usedPercent: 97, resetsRaw: null, resetsAtMs: now + 3_600_000 },
      ]),
      usage_checked_at: now,
    });

    const { restore } = captureFetch(() => Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }));

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "session-cutoff-weekly" },
          body: JSON.stringify({ model: "claude-cutoff-weekly", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(getSticky("sid:session-cutoff-weekly")).toEqual({ accountId: fresh.id, status: "active" });
    } finally {
      restore();
    }
  });

  test("saturated accounts still serve new sessions when the whole pool is above the cutoff", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const first = createAccount({ name: "Cutoff all A", priority: 0 });
    seedAccountCredentials(first.id, {
      accessToken: "cutoff-all-a-access",
      refreshToken: "cutoff-all-a-refresh",
      expiresAt: now + 3_600_000,
    });
    const second = createAccount({ name: "Cutoff all B", priority: 1 });
    seedAccountCredentials(second.id, {
      accessToken: "cutoff-all-b-access",
      refreshToken: "cutoff-all-b-refresh",
      expiresAt: now + 3_600_000,
    });
    updateAccount(first.id, {
      usage_windows: sessionUsageWindows(96, now + 3_600_000),
      usage_checked_at: now,
    });
    updateAccount(second.id, {
      usage_windows: sessionUsageWindows(98, now + 3_600_000),
      usage_checked_at: now,
    });

    const { restore } = captureFetch(() => Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }));

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "session-cutoff-all" },
          body: JSON.stringify({ model: "claude-cutoff-all", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(getSticky("sid:session-cutoff-all")).toEqual({ accountId: first.id, status: "active" });
    } finally {
      restore();
    }
  });

  test("an existing sticky home above the cutoff keeps its sessions", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const home = createAccount({ name: "Cutoff home", priority: 0 });
    seedAccountCredentials(home.id, {
      accessToken: "cutoff-home-access",
      refreshToken: "cutoff-home-refresh",
      expiresAt: now + 3_600_000,
    });
    const other = createAccount({ name: "Cutoff other", priority: 1 });
    seedAccountCredentials(other.id, {
      accessToken: "cutoff-other-access",
      refreshToken: "cutoff-other-refresh",
      expiresAt: now + 3_600_000,
    });
    updateAccount(home.id, {
      usage_windows: sessionUsageWindows(96, now + 3_600_000),
      usage_checked_at: now,
    });
    claimSticky("sid:session-cutoff-home", home.id, now);

    const { restore } = captureFetch(() => Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }));

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "session-cutoff-home" },
          body: JSON.stringify({ model: "claude-cutoff-home", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(getSticky("sid:session-cutoff-home")).toEqual({ accountId: home.id, status: "active" });
      const logs = listRequests({ limit: 10, offset: 0, search: "claude-cutoff-home" });
      expect(logs.entries[0]?.account_id).toBe(home.id);
    } finally {
      restore();
    }
  });

  test("count_tokens and messages share one permanent Claude Code session home", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const home = createAccount({ name: "Shared endpoint home", priority: 0 });
    seedAccountCredentials(home.id, {
      accessToken: "shared-home-access",
      refreshToken: "shared-home-refresh",
      expiresAt: now + 3_600_000,
    });
    const other = createAccount({ name: "Shared endpoint other", priority: 1 });
    seedAccountCredentials(other.id, {
      accessToken: "shared-other-access",
      refreshToken: "shared-other-refresh",
      expiresAt: now + 3_600_000,
    });
    const headers = {
      "content-type": "application/json",
      "x-claude-code-session-id": "shared-endpoints",
    };
    const { headers: outboundHeaders, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const countResponse = await handleProxy(
        new Request("http://cc-lb.test/v1/messages/count_tokens?beta=true", {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "claude-shared-count", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages/count_tokens?beta=true"),
      );
      expect(countResponse.status).toBe(200);
      await countResponse.text();
      expect(getSticky("sid:shared-endpoints")).toEqual({ accountId: home.id, status: "pending" });

      updateAccount(home.id, { priority: 10 });
      updateAccount(other.id, { priority: 0 });
      const messageResponse = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "claude-shared-message", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(messageResponse.status).toBe(200);
      await messageResponse.text();

      expect(getSticky("sid:shared-endpoints")).toEqual({ accountId: home.id, status: "active" });
      expect(outboundHeaders).toHaveLength(2);
      expect(outboundHeaders.every((entry) => entry.get("authorization") === "Bearer shared-home-access")).toBe(true);
    } finally {
      restore();
    }
  });

  test("captures raw HTTP request and response only when enabled", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({ name: "Raw HTTP capture" });
    seedAccountCredentials(account.id, {
      accessToken: "raw-access",
      refreshToken: "raw-refresh",
      expiresAt: now + 3_600_000,
    });
    patchSettings({ rawHttpLoggingEnabled: true });

    const { restore } = captureFetch(() =>
      Response.json(
        { usage: { input_tokens: 3, output_tokens: 5 }, raw: "response body marker" },
        { headers: { "content-type": "application/json", "x-upstream-debug": "seen" } },
      ),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages?beta=1", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer client-key" },
          body: JSON.stringify({
            model: "claude-raw-http",
            messages: [{ role: "user", content: "raw body marker" }],
            account_uuid: "",
          }),
        }),
        new URL("http://cc-lb.test/v1/messages?beta=1"),
      );
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const logs = listRequests({ limit: 10, offset: 0, search: "claude-raw-http" });
      expect(logs.total).toBe(1);
      expect(logs.entries[0]?.raw_request_headers).toContain("\"authorization\": \"Bearer client-key\"");
      expect(logs.entries[0]?.raw_request_body).toContain("raw body marker");
      const upstreamHead = logs.entries[0]?.raw_upstream_request_headers ?? "";
      expect(upstreamHead).toContain("https://api.anthropic.com/v1/messages?beta=1");
      expect(upstreamHead).toContain("\"authorization\": \"Bearer [redacted]\"");
      expect(upstreamHead).not.toContain("raw-access");
      expect(upstreamHead).toContain("oauth-2025-04-20");
      // Off-path account-like fields are not identity slots and remain untouched.
      expect(logs.entries[0]?.raw_upstream_request_body).toContain("raw body marker");
      expect(logs.entries[0]?.raw_upstream_request_body).toContain('"account_uuid":""');
      expect(logs.entries[0]?.raw_upstream_request_body).not.toContain(account.id);
      expect(logs.entries[0]?.raw_request_body).not.toContain(account.id);
      expect(logs.entries[0]?.raw_response_headers).toContain("\"x-upstream-debug\": \"seen\"");
      expect(logs.entries[0]?.raw_response_body).toContain("response body marker");
    } finally {
      patchSettings({ rawHttpLoggingEnabled: false });
      restore();
    }
  });

  test("disables upstream TCP connection reuse", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({ name: "No keepalive" });
    seedAccountCredentials(account.id, {
      accessToken: "no-keepalive-access",
      refreshToken: "no-keepalive-refresh",
      expiresAt: now + 3_600_000,
    });

    const { headers: outboundHeaders, inits, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", connection: "keep-alive" },
          body: JSON.stringify({ model: "claude-no-keepalive", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(inits[0]?.keepalive).toBe(false);
      expect(outboundHeaders[0]?.get("connection")).toBe("close");
    } finally {
      restore();
    }
  });

  test("passes the matching client user-agent upstream unchanged", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({ name: "UA passthrough" });
    seedAccountCredentials(account.id, {
      accessToken: "ua-pass-access",
      refreshToken: "ua-pass-refresh",
      expiresAt: now + 3_600_000,
    });

    const { headers: outboundHeaders, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": `claude-cli/${installedVersion} (external, sdk-ts, agent-sdk/0.3.199)`,
          },
          body: JSON.stringify({ model: "claude-ua-passthrough", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundHeaders[0]?.get("user-agent")).toBe(
        `claude-cli/${installedVersion} (external, sdk-ts, agent-sdk/0.3.199)`,
      );
    } finally {
      restore();
    }
  });

  test("strips forwarded headers from the upstream request when enabled", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({ name: "Strip forwarded" });
    seedAccountCredentials(account.id, {
      accessToken: "strip-access",
      refreshToken: "strip-refresh",
      expiresAt: now + 3_600_000,
    });
    patchSettings({ stripForwardedHeaders: true });

    const { headers: outboundHeaders, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.7",
            "x-real-ip": "203.0.113.7",
            via: "1.1 nginx",
          },
          body: JSON.stringify({ model: "claude-strip-forwarded", messages: [] }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(outboundHeaders[0]?.get("x-forwarded-for")).toBeNull();
      expect(outboundHeaders[0]?.get("x-real-ip")).toBeNull();
      expect(outboundHeaders[0]?.get("via")).toBeNull();
    } finally {
      patchSettings({ stripForwardedHeaders: false });
      restore();
    }
  });

  test("does not add the account machineID to requests without a device id signal", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const acct = createAccount({
      name: "Folder device inactive",
    });
    seedAccountCredentials(acct.id, {
      accessToken: "device-access-a",
      refreshToken: "device-refresh-a",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
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

  test("rejects a top-level device id instead of treating it as an identity field", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const acct = createAccount({
      name: "Folder device active",
    });
    seedAccountCredentials(acct.id, {
      accessToken: "device-access-b",
      refreshToken: "device-refresh-b",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
    });

    const sessionId = "off-path-top-level-device";
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
          body: JSON.stringify({ model: "claude-body-device", messages: [], device_id: "client-device" }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("unexpected_device_identity");
      expect(inits).toHaveLength(0);
      expect(getSticky(`sid:${sessionId}`)).toBeNull();
    } finally {
      restore();
    }
  });

  test("rewrites the device id header from the account folder without touching the body", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const acct = createAccount({
      name: "Folder device header only",
    });
    seedAccountCredentials(acct.id, {
      accessToken: "device-access-c",
      refreshToken: "device-refresh-c",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
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

  test("rejects device-like fields outside the exact user_id envelope", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const acct = createAccount({
      name: "Folder device strict paths",
    });
    seedAccountCredentials(acct.id, {
      accessToken: "device-access-d",
      refreshToken: "device-refresh-d",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
    });

    const sessionId = "off-path-nested-devices";
    const { inits, restore } = captureFetch(() => Response.json({ unexpected: true }));

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": sessionId,
            [DEVICE_ID_HEADER]: "client-device",
          },
          body: JSON.stringify({
            model: "claude-both-device",
            messages: [{ role: "user", content: "hi", device_id: "history-device-value" }],
            metadata: { deviceId: "metadata-client-device" },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("unexpected_device_identity");
      expect(inits).toHaveLength(0);
      expect(getSticky(`sid:${sessionId}`)).toBeNull();
    } finally {
      restore();
    }
  });

  test("does not send a session body to another account after a rate limit", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const failoverA = createAccount({
      name: "Failover device A",
      priority: 0,
    });
    seedAccountCredentials(failoverA.id, {
      accessToken: "failover-access-a",
      refreshToken: "failover-refresh-a",
      expiresAt: now + 3_600_000,
      machineId: "device-a",
    });
    const failoverB = createAccount({
      name: "Failover device B",
      priority: 1,
    });
    seedAccountCredentials(failoverB.id, {
      accessToken: "failover-access-b",
      refreshToken: "failover-refresh-b",
      expiresAt: now + 3_600_000,
    });

    let call = 0;
    const { bodies: outboundBodies, restore } = captureFetch(() => {
      call += 1;
      if (call === 1) return new Response("limited", { status: 429 });
      return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
    });
    const sessionId = "failover-device-envelope";
    const userId = JSON.stringify({
      device_id: "client-device",
      account_uuid: "client-account",
      session_id: sessionId,
    });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
          body: JSON.stringify({
            model: "claude-failover-device",
            messages: [],
            metadata: { user_id: userId },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(503);
      await response.json();
      expect(outboundBodies.length).toBe(1);
      const sentUserId = JSON.parse(decodeBody(outboundBodies[0]).metadata.user_id);
      expect(sentUserId.device_id).toBe("device-a");
      expect(sentUserId.account_uuid).toBe(failoverA.id);
      expect(getSticky(`sid:${sessionId}`)).toEqual({ accountId: failoverA.id, status: "active" });
    } finally {
      restore();
    }
  });

  test("forwards exact body bytes while leaving an off-path account id untouched", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const acct = createAccount({
      name: "Identity noop",
    });
    seedAccountCredentials(acct.id, {
      accessToken: "identity-noop-access",
      refreshToken: "identity-noop-refresh",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
    });

    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    // Odd spacing and a trailing-zero float would not survive JSON re-serialization.
    const rawBody =
      `{ "model": "claude-noop-identity",  "messages": [],\n` +
      `  "temperature": 1.0, "account_uuid": "client-off-path-account" }`;

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawBody,
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(decodeBodyText(outboundBodies[0])).toBe(rawBody);
    } finally {
      restore();
    }
  });

  test("keeps the metadata.user_id envelope string untouched when its identity already matches", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const acct = createAccount({
      name: "Envelope noop",
    });
    seedAccountCredentials(acct.id, {
      accessToken: "envelope-noop-access",
      refreshToken: "envelope-noop-refresh",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
    });

    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    // Envelope formatted with spaces: any rewrite would compact it.
    const userId = `{ "device_id": "account-device", "account_uuid": "${acct.id}", "session_id": "sess-envelope-noop" }`;
    const rawBody = JSON.stringify({ model: "claude-noop-envelope", messages: [], metadata: { user_id: userId } });

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-envelope-noop" },
          body: rawBody,
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(decodeBodyText(outboundBodies[0])).toBe(rawBody);
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
    });
    seedAccountCredentials(account.id, {
      accessToken: "uuid-access-a",
      refreshToken: "uuid-refresh-a",
      expiresAt: now + 3_600_000,
      machineId: "4c646496947b2cb162e80ccba59ec0bd84bc1e96b79d73400b036b5fa6973f59",
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
          headers: {
            "content-type": "application/json",
            "x-claude-code-session-id": "d9d81c35-a75c-498a-b7b8-7d1614b38280",
          },
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

  test("patches account_uuid and device_id to the account's real Claude folder identity", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({ name: "Real folder identity" });
    seedAccountCredentials(account.id, { accessToken: "real-access", refreshToken: "real-refresh", expiresAt: now + 3_600_000 });
    // Claude Code's real identity, as adopted from a login dir.
    writeAccountClaudeJson(account.id, {
      hasCompletedOnboarding: true,
      machineID: "real-machine-id-hash",
      accountUuid: "64f27862-b305-4e53-9ca5-f913b529f556",
    });

    const userId = JSON.stringify({ device_id: "client-device", account_uuid: "client-uuid", session_id: "wrong-session" });
    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "validated-session" },
          body: JSON.stringify({ model: "claude-real-identity", messages: [], metadata: { user_id: userId } }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      const sentUserId = JSON.parse(decodeBody(outboundBodies[0]).metadata.user_id);
      // account_uuid is the real Anthropic uuid from .claude.json, NOT the internal account.id.
      expect(sentUserId.account_uuid).toBe("64f27862-b305-4e53-9ca5-f913b529f556");
      expect(sentUserId.account_uuid).not.toBe(account.id);
      expect(sentUserId.device_id).toBe("real-machine-id-hash");
      expect(sentUserId.session_id).toBe("validated-session");
    } finally {
      restore();
    }
  });

  test("patches account_uuid only inside the exact user_id envelope", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({ name: "Account uuid key presence" });
    seedAccountCredentials(account.id, {
      accessToken: "uuid-key-access",
      refreshToken: "uuid-key-refresh",
      expiresAt: now + 3_600_000,
    });
    writeAccountClaudeJson(account.id, {
      hasCompletedOnboarding: true,
      accountUuid: "a960e8fc-95ac-4afc-8c38-ed0d8422cf31",
    });

    const userId = JSON.stringify({ account_uuid: "", session_id: "sess-key-presence" });
    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "sess-key-presence" },
          body: JSON.stringify({
            model: "claude-account-uuid-key-presence",
            messages: [],
            account_uuid: null,
            metadata: { user_id: userId },
            nested: { accountUuid: 42 },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(200);
      await response.text();
      const sent = decodeBody(outboundBodies[0]);
      const sentUserId = JSON.parse(sent.metadata.user_id);
      expect(sent.account_uuid).toBeNull();
      expect(sent.nested.accountUuid).toBe(42);
      expect(sentUserId.account_uuid).toBe("a960e8fc-95ac-4afc-8c38-ed0d8422cf31");
      expect(sentUserId.session_id).toBe("sess-key-presence");
    } finally {
      restore();
    }
  });

  test("rewrites device_id inside the user_id envelope from the account folder machineID", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({
      name: "Envelope folder device",
    });
    seedAccountCredentials(account.id, {
      accessToken: "uuid-access-b",
      refreshToken: "uuid-refresh-b",
      expiresAt: now + 3_600_000,
      machineId: "account-device",
    });

    const userId = JSON.stringify({ device_id: "client-device", account_uuid: "old-uuid", session_id: "s-1" });
    const { bodies: outboundBodies, restore } = captureFetch(() =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 2 } }),
    );

    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-claude-code-session-id": "s-1" },
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

  test("leaves bare account_uuid fields and plain user_id strings untouched", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const account = createAccount({
      name: "Bare account uuid",
    });
    seedAccountCredentials(account.id, {
      accessToken: "uuid-access-c",
      refreshToken: "uuid-refresh-c",
      expiresAt: now + 3_600_000,
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
      expect(sent.account_uuid).toBe("");
      expect(sent.metadata.user_id).toBe("session_abc123");
    } finally {
      restore();
    }
  });

  test("does not try another account when a metadata session fails", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const first = createAccount({
      name: "Uuid failover A",
      priority: 0,
    });
    seedAccountCredentials(first.id, {
      accessToken: "uuid-failover-a",
      refreshToken: "uuid-failover-ra",
      expiresAt: now + 3_600_000,
      machineId: "client-device-d",
    });
    const second = createAccount({
      name: "Uuid failover B",
      priority: 1,
    });
    seedAccountCredentials(second.id, {
      accessToken: "uuid-failover-b",
      refreshToken: "uuid-failover-rb",
      expiresAt: now + 3_600_000,
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
          headers: { "content-type": "application/json", "x-claude-code-session-id": "s" },
          body: JSON.stringify({
            model: "claude-uuid-failover",
            messages: [],
            metadata: {
              user_id: JSON.stringify({ device_id: "client-device-d", account_uuid: "", session_id: "s" }),
            },
          }),
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(503);
      await response.json();
      expect(outboundBodies.length).toBe(1);
      expect(JSON.parse(decodeBody(outboundBodies[0]).metadata.user_id).account_uuid).toBe(first.id);
      expect(getSticky("sid:s")).toEqual({ accountId: first.id, status: "active" });
    } finally {
      restore();
    }
  });

  test("returns 499 when the client has disconnected", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const first = createAccount({ name: "Abort stop A", priority: 0 });
    seedAccountCredentials(first.id, {
      accessToken: "abort-access-a",
      refreshToken: "abort-refresh-a",
      expiresAt: now + 3_600_000,
    });
    const second = createAccount({ name: "Abort stop B", priority: 1 });
    seedAccountCredentials(second.id, {
      accessToken: "abort-access-b",
      refreshToken: "abort-refresh-b",
      expiresAt: now + 3_600_000,
    });

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        return Response.json({ usage: { input_tokens: 1, output_tokens: 2 } });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const controller = new AbortController();
    controller.abort();
    try {
      const response = await handleProxy(
        new Request("http://cc-lb.test/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-client-abort", messages: [] }),
          signal: controller.signal,
        }),
        new URL("http://cc-lb.test/v1/messages"),
      );
      expect(response.status).toBe(499);
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps an out-of-credits session pinned without benching or failover", async () => {
    const now = Date.now();
    for (const account of listAccounts()) {
      updateAccount(account.id, { paused: 1 });
    }
    const creditless = createAccount({
      name: "Out of credits",
      priority: 0,
    });
    seedAccountCredentials(creditless.id, {
      accessToken: "credits-access-a",
      refreshToken: "credits-refresh-a",
      expiresAt: now + 3_600_000,
    });
    const fallback = createAccount({
      name: "Credits fallback",
      priority: 1,
    });
    seedAccountCredentials(fallback.id, {
      accessToken: "credits-access-b",
      refreshToken: "credits-refresh-b",
      expiresAt: now + 3_600_000,
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
      expect(response.status).toBe(503);
      await response.json();

      const benched = getAccount(creditless.id);
      expect(benched?.rate_limited_until).toBeNull();
      expect(benched?.consecutive_rate_limits).toBe(0);

      const logs = listRequests({ limit: 10, offset: 0, search: "claude-out-of-credits" });
      const creditlessEntry = logs.entries.find((entry) => entry.account_id === creditless.id);
      const fallbackEntry = logs.entries.find((entry) => entry.account_id === fallback.id);
      expect(creditlessEntry?.outcome).toBe("rate_limited");
      expect(fallbackEntry).toBeUndefined();
      expect(call).toBe(1);
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
    });
    seedAccountCredentials(reauth.id, {
      accessToken: "reauth-access",
      refreshToken: "reauth-refresh",
      expiresAt: now + 3_600_000,
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
    });
    seedAccountCredentials(limited.id, {
      accessToken: "limited-access",
      refreshToken: "limited-refresh",
      expiresAt: now + 3_600_000,
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

function sessionUsageWindows(usedPercent: number, resetsAtMs: number | null): string {
  return JSON.stringify([
    { label: "Current session", kind: "session", model: null, usedPercent, resetsRaw: null, resetsAtMs },
  ]);
}

function captureFetch(respond: () => Response) {
  const headers: Headers[] = [];
  const bodies: (BodyInit | null | undefined)[] = [];
  const inits: RequestInit[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      headers.push(new Headers(init?.headers));
      bodies.push(init?.body);
      return respond();
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return {
    headers,
    bodies,
    inits,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function decodeBody(body: BodyInit | null | undefined) {
  return JSON.parse(decodeBodyText(body));
}

function decodeBodyText(body: BodyInit | null | undefined): string {
  if (!(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
    throw new Error("expected binary outbound body");
  }
  return new TextDecoder().decode(body);
}

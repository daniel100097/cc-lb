import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-oauth-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const oauth = await import("./oauth");
const sessions = await import("../db/oauth-sessions");

function fetchMock(mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(mock, { preconnect: globalThis.fetch.preconnect });
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: Error | null = null;
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      caught = error;
    } else {
      throw error;
    }
  }
  expect(caught).toBeTruthy();
  expect(caught?.message).toContain(message);
}

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("Anthropic OAuth", () => {
  test("beginOAuth creates a durable PKCE session with metadata", () => {
    const result = oauth.beginOAuth({ accountId: "acct_1", name: "Primary", priority: 7 });
    const session = sessions.getOAuthSession(result.sessionId);
    const authUrl = new URL(result.authUrl);

    expect(session?.account_id).toBe("acct_1");
    expect(session?.name).toBe("Primary");
    expect(session?.priority).toBe(7);
    expect(authUrl.searchParams.get("code")).toBe("true");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("client_id")).toBeTruthy();
  });

  test("state mismatch rejects before token exchange and leaves session reusable", async () => {
    const result = oauth.beginOAuth({ name: "Mismatch" });
    const session = sessions.getOAuthSession(result.sessionId);
    expect(session).toBeTruthy();

    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock(function mock() {
      calls += 1;
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    try {
      await expectRejectsWithMessage(oauth.completeOAuth(result.sessionId, "code#wrong-state"), "oauth state mismatch");
      expect(calls).toBe(0);
      expect(sessions.getOAuthSession(result.sessionId)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("missing state rejects before token exchange", async () => {
    const result = oauth.beginOAuth({ name: "Missing state" });
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock(function mock() {
      calls += 1;
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    });

    try {
      await expectRejectsWithMessage(
        oauth.completeOAuth(result.sessionId, "code-only"),
        "oauth code must be in code#state format",
      );
      expect(calls).toBe(0);
      expect(sessions.getOAuthSession(result.sessionId)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("failed token exchange does not consume the OAuth session", async () => {
    const result = oauth.beginOAuth({ name: "Retryable" });
    const session = sessions.getOAuthSession(result.sessionId);
    expect(session).toBeTruthy();
    const state = session?.state ?? "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock(function mock() {
      return Promise.resolve(new Response("temporary failure", { status: 503 }));
    });

    try {
      await expectRejectsWithMessage(oauth.completeOAuth(result.sessionId, `code#${state}`), "token exchange failed");
      expect(sessions.getOAuthSession(result.sessionId)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("successful completion returns tokens and can consume the session afterward", async () => {
    const result = oauth.beginOAuth({ name: "Success", priority: 3 });
    const session = sessions.getOAuthSession(result.sessionId);
    expect(session).toBeTruthy();
    const state = session?.state ?? "";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock(async function mock(_input: RequestInfo | URL, init?: RequestInit) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      expect(body.grant_type).toBe("authorization_code");
      expect(body.state).toBe(state);
      expect(body.code_verifier).toBe(session?.verifier);
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "user:inference",
      });
    });

    try {
      const completion = await oauth.completeOAuth(result.sessionId, `code#${state}`);
      expect(completion.tokens.accessToken).toBe("access-token");
      expect(completion.tokens.refreshToken).toBe("refresh-token");
      expect(completion.session.priority).toBe(3);
      expect(sessions.getOAuthSession(result.sessionId)).toBeTruthy();
      oauth.consumeOAuthSession(result.sessionId);
      expect(sessions.getOAuthSession(result.sessionId)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

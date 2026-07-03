import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createOAuthSession,
  deleteOAuthSession,
  getOAuthSession,
  type OAuthSession,
} from "../db/oauth-sessions";
import { AUTH_URL, CLIENT_ID, REDIRECT_URI, SCOPES, TOKEN_URL } from "./constants";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const SESSION_TTL_MS = 10 * 60 * 1000;

export interface BeginResult {
  authUrl: string;
  sessionId: string;
}

export interface BeginOAuthOptions {
  accountId?: string | null;
  name?: string | null;
  priority?: number;
}

export function beginOAuth(options: BeginOAuthOptions = {}): BeginResult {
  const now = Date.now();
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(32).toString("hex");
  const sessionId = randomBytes(16).toString("hex");
  createOAuthSession({
    id: sessionId,
    verifier,
    state,
    accountId: options.accountId,
    name: options.name,
    priority: options.priority,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });

  const url = new URL(AUTH_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { authUrl: url.toString(), sessionId };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string | null;
}

export interface OAuthCompletion {
  tokens: TokenSet;
  session: OAuthSession;
}

const tokenSetSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
});

const refreshResultSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
});

class RefreshTokenError extends Error {
  readonly needsReauth: boolean;

  constructor(message: string, needsReauth: boolean) {
    super(message);
    this.name = "RefreshTokenError";
    this.needsReauth = needsReauth;
  }
}

export function isReauthRequiredError(error: unknown): boolean {
  return error instanceof RefreshTokenError && error.needsReauth;
}

/** Exchange the pasted `code#state` for tokens. Call consumeOAuthSession after persisting tokens. */
export async function completeOAuth(sessionId: string, rawCode: string): Promise<OAuthCompletion> {
  const session = getOAuthSession(sessionId);
  if (!session) throw new Error("oauth session expired or not found");

  const codeWithState = rawCode.trim();
  const stateSeparator = codeWithState.indexOf("#");
  if (
    stateSeparator <= 0 ||
    stateSeparator !== codeWithState.lastIndexOf("#") ||
    stateSeparator === codeWithState.length - 1
  ) {
    throw new Error("oauth code must be in code#state format");
  }

  const authCode = codeWithState.slice(0, stateSeparator);
  const returnedState = codeWithState.slice(stateSeparator + 1);
  if (returnedState !== session.state) {
    throw new Error("oauth state mismatch");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: authCode,
      state: returnedState,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: session.verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = tokenSetSchema.parse(await res.json());
  return {
    session,
    tokens: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      scopes: json.scope ?? null,
    },
  };
}

export function consumeOAuthSession(sessionId: string): void {
  deleteOAuthSession(sessionId);
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** Refresh an access token. `needsReauth` distinguishes fatal grant errors. */
export async function refreshToken(currentRefresh: string): Promise<RefreshResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: currentRefresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const needsReauth = res.status === 401 || /invalid_grant|invalid_refresh_token|not supported/i.test(body);
    throw new RefreshTokenError(`refresh failed (${res.status}): ${body}`, needsReauth);
  }
  const json = refreshResultSchema.parse(await res.json());
  return {
    accessToken: json.access_token,
    // Rotation-tolerant: keep the old refresh token if none returned.
    refreshToken: json.refresh_token ?? currentRefresh,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

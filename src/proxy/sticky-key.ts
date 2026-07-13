export const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";

/**
 * Claude Code supplies one stable session id for the lifetime of a chat. No
 * other request identity is accepted because a heuristic could merge chats or
 * let one chat move between accounts.
 */
export function deriveStickyKey(headers: Headers): string | null {
  const sessionId = headers.get(CLAUDE_CODE_SESSION_HEADER)?.trim();
  return sessionId ? `sid:${sessionId}` : null;
}

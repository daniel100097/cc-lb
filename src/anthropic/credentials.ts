export function extractClaudeCodeOAuthToken(input: string): string {
  return findClaudeCodeOAuthToken(input) ?? input.trim();
}

export function findClaudeCodeOAuthToken(input: string): string | null {
  const trimmed = input.trim();
  const envMatch = trimmed.match(/(?:^|\s)(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const token = envMatch?.[1] ?? envMatch?.[2] ?? envMatch?.[3];
  return token ? token.trim() : null;
}

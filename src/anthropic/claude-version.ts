import { readFileSync } from "node:fs";

let cachedUserAgent: string | null | undefined;

/**
 * User-agent matching the bundled Claude Code CLI (the same package the login
 * flow runs), e.g. "claude-cli/2.1.201 (external, cli)". Null when the package
 * cannot be resolved.
 */
export function installedClaudeUserAgent(): string | null {
  if (cachedUserAgent === undefined) cachedUserAgent = readInstalledUserAgent();
  return cachedUserAgent;
}

/**
 * Effective user-agent override for upstream requests: empty disables the
 * override, the "auto" sentinel tracks the bundled Claude Code version, and
 * anything else is sent verbatim.
 */
export function resolveUserAgentOverride(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "auto") return installedClaudeUserAgent();
  return trimmed;
}

function readInstalledUserAgent(): string | null {
  try {
    const pkgPath = Bun.resolveSync("@anthropic-ai/claude-code/package.json", import.meta.dir);
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const version = isRecord(parsed) ? parsed.version : undefined;
    if (typeof version !== "string" || version.length === 0) return null;
    return `claude-cli/${version} (external, cli)`;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

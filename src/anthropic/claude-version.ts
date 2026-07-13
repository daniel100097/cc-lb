import { readFileSync } from "node:fs";

let cachedVersion: string | null | undefined;

export function installedClaudeVersion(): string | null {
  if (cachedVersion === undefined) cachedVersion = readInstalledVersion();
  return cachedVersion;
}

export function claudeUserAgentVersion(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return /^claude-cli\/([^\s()]+)/.exec(userAgent.trim())?.[1] ?? null;
}

export function matchesInstalledClaudeVersion(userAgent: string | null): boolean {
  const installed = installedClaudeVersion();
  return installed !== null && claudeUserAgentVersion(userAgent) === installed;
}

function readInstalledVersion(): string | null {
  try {
    const pkgPath = Bun.resolveSync("@anthropic-ai/claude-code/package.json", import.meta.dir);
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const version = isRecord(parsed) ? parsed.version : undefined;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

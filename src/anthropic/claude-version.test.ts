import { describe, expect, test } from "bun:test";
import { installedClaudeUserAgent, resolveUserAgentOverride } from "./claude-version";

describe("claude-version", () => {
  test("builds the user-agent from the bundled Claude Code package version", () => {
    expect(installedClaudeUserAgent()).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  });

  test("resolves the override: empty disables, auto tracks the bundled version, literals pass through", () => {
    expect(resolveUserAgentOverride("")).toBeNull();
    expect(resolveUserAgentOverride("   ")).toBeNull();
    expect(resolveUserAgentOverride("auto")).toBe(installedClaudeUserAgent());
    expect(resolveUserAgentOverride(" AUTO ")).toBe(installedClaudeUserAgent());
    expect(resolveUserAgentOverride("claude-cli/2.1.198 (external, cli)")).toBe("claude-cli/2.1.198 (external, cli)");
  });
});

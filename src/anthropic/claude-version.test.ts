import { describe, expect, test } from "bun:test";
import {
  claudeUserAgentVersion,
  installedClaudeVersion,
  matchesInstalledClaudeVersion,
} from "./claude-version";

describe("claude-version", () => {
  test("reads the bundled Claude Code package version", () => {
    expect(installedClaudeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("extracts Claude Code versions from supported user-agent variants", () => {
    expect(claudeUserAgentVersion("claude-cli/2.1.201 (external, cli)")).toBe("2.1.201");
    expect(claudeUserAgentVersion("claude-cli/2.1.201 (external, sdk-ts, agent-sdk/0.3.199)")).toBe("2.1.201");
    expect(claudeUserAgentVersion("other/2.1.201")).toBeNull();
    expect(claudeUserAgentVersion(null)).toBeNull();
  });

  test("requires the incoming version to match the bundled version", () => {
    const installed = installedClaudeVersion();
    expect(installed).not.toBeNull();
    expect(matchesInstalledClaudeVersion(`claude-cli/${installed} (external, cli)`)).toBe(true);
    expect(matchesInstalledClaudeVersion(`claude-cli/${installed} (external, sdk-ts, agent-sdk/0.3.199)`)).toBe(true);
    expect(matchesInstalledClaudeVersion("claude-cli/0.0.0 (external, cli)")).toBe(false);
    expect(matchesInstalledClaudeVersion("curl/8.0")).toBe(false);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  buildClaudeCodeLoginEnv,
  cleanClaudeCodeOutput,
  extractClaudeCodeAuthUrl,
  extractClaudeCodeTokenFromOutput,
  resetClaudeCodeLoginSessionsForTests,
} from "./claude-code-cli";

afterEach(() => {
  resetClaudeCodeLoginSessionsForTests();
});

describe("Claude Code CLI login parsing", () => {
  test("builds a local Claude CLI command instead of relying on PATH lookup", () => {
    const env = buildClaudeCodeLoginEnv({});

    expect(env.CLAUDE_CODE_LOGIN_COMMAND).toBe(`'${process.cwd()}/node_modules/.bin/claude' setup-token`);
    expect(env.PATH?.startsWith(`${process.cwd()}/node_modules/.bin:`)).toBe(true);
    expect(env.CLAUDE_CODE_NO_FLICKER).toBe("0");
  });

  test("extracts the authorize URL from wrapped TUI output", () => {
    const output = [
      "\x1b[2GBrowser didn't open? Use the url below",
      "",
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc",
      "&response_type=code&state=xyz",
      "",
      "\x1b[2GPaste code here if prompted >",
    ].join("\r\n");

    expect(extractClaudeCodeAuthUrl(output)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&state=xyz",
    );
  });

  test("extracts the OAuth token env var from CLI output", () => {
    expect(extractClaudeCodeTokenFromOutput("Done\nCLAUDE_CODE_OAUTH_TOKEN='claude-code-oauth-token-value'")).toBe(
      "claude-code-oauth-token-value",
    );
  });

  test("cleans ansi cursor controls", () => {
    expect(cleanClaudeCodeOutput("Hello\x1b[9Gthere\r\n")).toContain("Hellothere\n");
  });
});

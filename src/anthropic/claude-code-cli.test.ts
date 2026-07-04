import { afterEach, describe, expect, test } from "bun:test";
import {
  buildClaudeCodeLoginEnv,
  buildTmuxLoginCommand,
  cleanClaudeCodeOutput,
  extractClaudeCodeAuthUrl,
  extractClaudeCodeTokenFromOutput,
  getClaudeCodeCredentialsPath,
  getClaudeCodeTmuxSocketPath,
  redactClaudeCodeOutput,
  resetClaudeCodeLoginSessionsForTests,
} from "./claude-code-cli";

afterEach(() => {
  resetClaudeCodeLoginSessionsForTests();
});

describe("Claude Code CLI login parsing", () => {
  test("builds a local Claude CLI command instead of relying on PATH lookup", () => {
    const env = buildClaudeCodeLoginEnv({});

    expect(env.CLAUDE_CODE_LOGIN_COMMAND).toBe(`'${process.cwd()}/node_modules/.bin/claude'`);
    expect(env.PATH?.startsWith(`${process.cwd()}/node_modules/.bin:`)).toBe(true);
    expect(env.CLAUDE_CODE_NO_FLICKER).toBe("0");
  });

  test("uses explicit tmux and credentials paths", () => {
    expect(getClaudeCodeTmuxSocketPath({})).toBe("/tmp/cc-lb-claude-code.tmux");
    expect(getClaudeCodeTmuxSocketPath({ CLAUDE_CODE_TMUX_SOCKET: "/tmp/custom.sock" })).toBe("/tmp/custom.sock");
    expect(getClaudeCodeCredentialsPath({ CLAUDE_CONFIG_DIR: "/tmp/claude" })).toBe("/tmp/claude/.credentials.json");
  });

  test("builds a tmux command that keeps the pane available for capture", () => {
    const command = buildTmuxLoginCommand({
      PATH: "/tmp/bin",
      TERM: "xterm-256color",
      CLAUDE_CODE_NO_FLICKER: "0",
      CLAUDE_CONFIG_DIR: "/tmp/claude",
      CLAUDE_CODE_LOGIN_COMMAND: "printf ready",
    });

    expect(command).toContain("printf ready");
    expect(command).toContain("[cc-lb] Claude Code process exited with status");
    expect(command).toContain("sleep 600");
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

  test("redacts OAuth token env vars from displayed output", () => {
    expect(redactClaudeCodeOutput("CLAUDE_CODE_OAUTH_TOKEN='secret-token'")).toBe("CLAUDE_CODE_OAUTH_TOKEN=[redacted]");
  });

  test("cleans ansi cursor controls", () => {
    expect(cleanClaudeCodeOutput("Hello\x1b[9Gthere\r\n")).toContain("Hellothere\n");
  });
});

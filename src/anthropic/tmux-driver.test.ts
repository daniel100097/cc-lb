import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeScreenReady, killPaneSession, shellQuote, startPaneSession, trustPromptKey, waitForOutput } from "./tmux-driver";

const prompt = "Quick safety check: Is this a project you created or one you trust?\n";

test("recognizes the current input screen and legacy welcome banners", () => {
  const header = "▐▛███▛█   Claude Code v2.1.261\nOpus 5 (1M context) · Claude Max\n/app\n";
  const input = '────────────────\n❯ Try "edit <filepath> to..."\n────────────────\n';
  expect(claudeScreenReady(`${header}Auto mode is now Claude Code's default permission mode.\n${input}Press Ctrl-C again to exit`)).toBe(true);
  expect(claudeScreenReady(`${header}────────────────\n❯ \n────────────────`)).toBe(true);
  expect(claudeScreenReady("Welcome back")).toBe(true);
  expect(claudeScreenReady("Tips for getting started")).toBe(true);
  expect(claudeScreenReady(header)).toBe(false);
  expect(claudeScreenReady(input)).toBe(false);
  expect(claudeScreenReady(`${header}${prompt}─ No, exit\n  Yes, I trust this folder`)).toBe(false);
  expect(claudeScreenReady(`${header}Select login method:\n❯ 1. Claude account`)).toBe(false);
});

test("trust navigation follows the selected label in either option order", () => {
  expect(trustPromptKey(`${prompt}─ No, exit\n  Yes, I trust this folder`)).toBe("Down");
  expect(trustPromptKey(`${prompt}  No, exit\n─ Yes, I trust this folder`)).toBe("C-m");
  expect(trustPromptKey(`${prompt}  1. Yes, I trust this folder\n❯ 2. No, exit`)).toBe("Up");
  expect(trustPromptKey(`${prompt}❯ 1. Yes, I trust this folder\n  2. No, exit`)).toBe("C-m");
  expect(trustPromptKey(`${prompt}1. Yes, I trust this folder`)).toBe("C-m");
});

test("trust navigation waits for a visible selection and ignores earlier prompts", () => {
  expect(trustPromptKey(`${prompt}No, exit\nYes, I trust this folder`)).toBeNull();
  expect(trustPromptKey(`${prompt}─ No, exit`)).toBeNull();
  expect(trustPromptKey(`${prompt}─ Yes, I trust this folder\n${prompt}─ No, exit\n  Yes, I trust this folder`)).toBe("Down");
});

test.each(["cancel-first", "confirm-first"])("tmux accepts trust without choosing exit (%s)", async (layout) => {
  const dir = mkdtempSync(join(tmpdir(), "cc-lb-trust-test-"));
  const cli = join(dir, "cli.ts");
  const previousCommand = process.env.CLAUDE_CODE_LOGIN_COMMAND;
  // Real raw terminal input: pressing Enter on No immediately fails the session.
  writeFileSync(cli, `
    let yes = ${layout === "confirm-first"};
    process.stdin.setRawMode(true);
    function render() {
      const options = ${layout === "cancel-first"}
        ? [(yes ? '  ' : '─ ') + 'No, exit', (yes ? '─ ' : '  ') + 'Yes, I trust this folder']
        : [(yes ? '❯ ' : '  ') + '1. Yes, I trust this folder', (yes ? '  ' : '❯ ') + '2. No, exit'];
      process.stdout.write('\\x1b[2J\\x1b[H' + ${JSON.stringify(prompt)} + options.join('\\n') + '\\nEnter to confirm\\n');
    }
    process.stdin.on('data', (chunk) => {
      const input = chunk.toString();
      if (input.includes('\\x1b[B') || input.includes('\\x1b[A')) { yes = !yes; render(); }
      if (input.includes('\\r')) {
        if (!yes) process.exit(1);
        process.stdout.write('\\x1b[2J\\x1b[HWelcome back\\n');
      }
    });
    render();
  `);
  let session;
  try {
    process.env.CLAUDE_CODE_LOGIN_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(cli)}`;
    session = await startPaneSession({
      tmuxName: `cc-lb-trust-${process.pid}-${layout}`,
      configDir: dir,
      autoAnswer: { theme: false, loginMethod: false, security: false, trust: true },
      pollMs: 100,
    });
    await waitForOutput(session, (output) => output.includes("Welcome back") ? true : null, 10_000, "accepted trust");
    expect(session.exited).toBe(false);
  } finally {
    if (previousCommand === undefined) delete process.env.CLAUDE_CODE_LOGIN_COMMAND;
    else process.env.CLAUDE_CODE_LOGIN_COMMAND = previousCommand;
    if (session) await killPaneSession(session);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

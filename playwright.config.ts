import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.E2E_PORT ?? 18_884);
const proxyPort = Number(process.env.E2E_PROXY_PORT ?? port + 1);
const explicitBaseURL = process.env.E2E_BASE_URL;
const baseURL = explicitBaseURL ?? `http://127.0.0.1:${port}`;
const dbPath = process.env.E2E_DB_PATH ?? `/tmp/cc-lb-e2e-${process.pid}.db`;
const claudeConfigDir = process.env.E2E_CLAUDE_CONFIG_DIR ?? `/tmp/cc-lb-e2e-claude-${process.pid}`;
const claudeAccountsDir = process.env.E2E_CLAUDE_ACCOUNTS_DIR ?? `/tmp/cc-lb-e2e-accounts-${process.pid}`;
const chromiumExecutable = findChromiumExecutable();
const fakeClaudeCodeLoginCommand =
  "printf 'Choose the text style that looks best with your terminal\\n'; read theme; printf 'Select login method:\\n'; read method; printf 'https://claude.com/cai/oauth/authorize?code=true&client_id=e2e&state=playwright\\nPaste code here if prompted > '; read code; printf '\\nSecurity notes:\\nPress Enter to continue...\\n'; read security; printf '\\nQuick safety check: Is this a project you created or one you trust?\\n1. Yes, I trust this folder\\nEnter to confirm\\n'; read trust; mkdir -p \"$CLAUDE_CONFIG_DIR\"; printf '%s' '{\"claudeAiOauth\":{\"accessToken\":\"access-e2e\",\"refreshToken\":\"refresh-e2e\",\"expiresAt\":1800000000000,\"scopes\":[\"user:inference\"]}}' > \"$CLAUDE_CONFIG_DIR/.credentials.json\"; printf '\\nWelcome back E2E!\\nTips for getting started\\n'; sleep 30";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const command = [
  "rm",
  "-f",
  shellQuote(dbPath),
  shellQuote(`${dbPath}-wal`),
  shellQuote(`${dbPath}-shm`),
  "&&",
  "rm",
  "-rf",
  shellQuote(claudeConfigDir),
  "&&",
  "rm",
  "-rf",
  shellQuote(claudeAccountsDir),
  "&&",
  "bun",
  "run",
  "build",
  "&&",
  `DB_PATH=${shellQuote(dbPath)}`,
  `CLAUDE_ACCOUNTS_DIR=${shellQuote(claudeAccountsDir)}`,
  "bun",
  "tests/e2e/seed.ts",
  "&&",
  `DB_PATH=${shellQuote(dbPath)}`,
  `DASHBOARD_PORT=${port}`,
  `PROXY_PORT=${proxyPort}`,
  `CLAUDE_CONFIG_DIR=${shellQuote(claudeConfigDir)}`,
  `CLAUDE_ACCOUNTS_DIR=${shellQuote(claudeAccountsDir)}`,
  `CLAUDE_CODE_LOGIN_COMMAND=${shellQuote(fakeClaudeCodeLoginCommand)}`,
  "bun",
  "src/index.ts",
].join(" ");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : undefined,
  },
  webServer: explicitBaseURL
    ? undefined
    : {
        command,
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: false,
      },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});

function findChromiumExecutable(): string | undefined {
  const explicit = process.env.E2E_CHROMIUM_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;

  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browserRoot || !existsSync(browserRoot)) return undefined;

  let entries: string[];
  try {
    entries = readdirSync(browserRoot);
  } catch {
    return undefined;
  }

  for (const prefix of ["chromium_headless_shell-", "chromium-"]) {
    const dirs = entries.filter((entry) => entry.startsWith(prefix)).sort().reverse();
    for (const dir of dirs) {
      const executable =
        prefix === "chromium_headless_shell-"
          ? join(browserRoot, dir, "chrome-headless-shell-linux64", "chrome-headless-shell")
          : join(browserRoot, dir, "chrome-linux64", "chrome");
      if (existsSync(executable)) return executable;
    }
  }

  return undefined;
}

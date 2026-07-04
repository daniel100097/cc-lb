import { defineConfig } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.E2E_PORT ?? 18_884);
const explicitBaseURL = process.env.E2E_BASE_URL;
const baseURL = explicitBaseURL ?? `http://127.0.0.1:${port}`;
const dbPath = process.env.E2E_DB_PATH ?? `/tmp/cc-lb-e2e-${process.pid}.db`;
const chromiumExecutable = findChromiumExecutable();
const fakeClaudeCodeLoginCommand =
  "printf 'https://claude.com/cai/oauth/authorize?code=true&client_id=e2e&state=playwright\\nPaste code here if prompted > '; read code; printf '\\nCLAUDE_CODE_OAUTH_TOKEN=claude-code-token-e2e-value-from-cli\\n'";

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
  "bun",
  "run",
  "build",
  "&&",
  `DB_PATH=${shellQuote(dbPath)}`,
  "bun",
  "tests/e2e/seed.ts",
  "&&",
  `DB_PATH=${shellQuote(dbPath)}`,
  `PORT=${port}`,
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

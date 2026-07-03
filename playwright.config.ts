import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 18_000 + (process.pid % 10_000));
const explicitBaseURL = process.env.E2E_BASE_URL;
const baseURL = explicitBaseURL ?? `http://127.0.0.1:${port}`;
const dbPath = process.env.E2E_DB_PATH ?? `/tmp/cc-lb-e2e-${process.pid}.db`;

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
  reporter: "list",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
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

import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

function proxyBaseUrl(): string {
  const explicitProxyUrl = process.env.E2E_PROXY_BASE_URL;
  if (explicitProxyUrl) return explicitProxyUrl;

  const dashboardUrl = new URL(
    process.env.E2E_BASE_URL ?? `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 18_884)}`,
  );
  dashboardUrl.port = String(
    Number(process.env.E2E_PROXY_PORT ?? Number(dashboardUrl.port || (dashboardUrl.protocol === "https:" ? 443 : 80)) + 1),
  );
  return dashboardUrl.origin;
}

test.describe("cc-lb dashboard with seeded data", () => {
  test("keeps dashboard and Claude proxy routes on separate listeners", async ({ request }) => {
    const dashboardHealth = await request.get("/api/health");
    expect(dashboardHealth.status()).toBe(200);
    await expect(dashboardHealth.json()).resolves.toMatchObject({
      ok: true,
      service: "cc-lb-dashboard",
    });

    const dashboardProxyRoute = await request.post("/v1/messages", { data: {} });
    expect(dashboardProxyRoute.status()).toBe(404);
    const dashboardTelemetry = await request.post("/api/event_logging/batch", { data: { events: [] } });
    expect(dashboardTelemetry.status()).toBe(404);

    const proxyUrl = proxyBaseUrl();
    const proxyHealth = await fetch(`${proxyUrl}/api/health`);
    expect(proxyHealth.status).toBe(200);
    await expect(proxyHealth.json()).resolves.toMatchObject({
      ok: true,
      service: "cc-lb-proxy",
    });

    const proxyDashboard = await fetch(`${proxyUrl}/`);
    expect(proxyDashboard.status).toBe(404);

    const proxyTrpc = await fetch(`${proxyUrl}/api/trpc/health`);
    expect(proxyTrpc.status).toBe(404);
  });

  test("renders dashboard health and seeded account states", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Primary healthy", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Rate limited", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Needs reauth", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Requests (7d)", { exact: true })).toBeVisible();
    await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
    await expect(page.locator("pre").filter({ hasText: "ANTHROPIC_BASE_URL" })).toContainText(
      `export ANTHROPIC_BASE_URL=${proxyBaseUrl()}`,
    );
  });

  test("adds and pauses an account through the Claude Code CLI flow", async ({ page }) => {
    await page.goto("/accounts");

    await page.getByRole("button", { name: "Add Account" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Claude account" });
    await dialog.getByLabel("Name").fill("CLI E2E");
    await dialog.getByRole("button", { name: "Generate login link" }).click();
    await expect(
      dialog.getByText("https://claude.com/cai/oauth/authorize?code=true&client_id=e2e&state=playwright", { exact: true }).first(),
    ).toBeVisible();
    await expect(dialog.getByLabel("Tmux attach command")).toContainText("tmux -S '/tmp/cc-lb-claude-code.tmux' attach -t");
    await expect(dialog.getByLabel("Claude Code output")).toContainText("Paste code here if prompted");
    await dialog.getByRole("textbox", { name: "Claude code" }).fill("code-from-claude");
    await dialog.getByRole("button", { name: "Add account" }).click();

    await expect(page.getByText("Claude Code account added")).toBeVisible();
    const tokenRow = page.getByRole("row").filter({ hasText: "CLI E2E" });
    await expect(tokenRow).toBeVisible();
    await tokenRow.getByTitle("Pause").click();
    await expect(page.getByText("Account paused")).toBeVisible();
    await expect(tokenRow.getByText("Paused")).toBeVisible();
  });

  test("filters and expands request log rows", async ({ page }) => {
    await page.goto("/requests");

    await expect(page.getByRole("heading", { name: "Requests" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "claude-sonnet-e2e" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "claude-haiku-e2e" })).toBeVisible();

    await page.getByLabel("Search").fill("count_tokens");
    await expect(page.getByRole("row").filter({ hasText: "claude-haiku-e2e" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "claude-sonnet-e2e" })).toBeHidden();

    await page.getByLabel("Search").fill("");
    await page.getByLabel("Outcome").selectOption("ok");
    await expect(page.getByRole("row").filter({ hasText: "claude-sonnet-e2e" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "claude-haiku-e2e" })).toBeHidden();

    await page.getByRole("row").filter({ hasText: "claude-sonnet-e2e" }).click();
    await expect(page.getByText("POST /v1/messages")).toBeVisible();
    await expect(page.getByText("req_e2e_ok")).toBeVisible();
    await expect(page.getByText("read 200 / create 50")).toBeVisible();
  });

  test("logs telemetry short-circuits into the request table", async ({ page }) => {
    const response = await fetch(`${proxyBaseUrl()}/api/event_logging/batch`, {
      body: JSON.stringify({ events: [] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(response.ok).toBe(true);

    await page.goto("/requests");
    await page.getByLabel("Outcome").selectOption("telemetry");
    await expect(page.getByRole("row").filter({ hasText: "Telemetry" })).toBeVisible();
    await page.getByRole("row").filter({ hasText: "Telemetry" }).first().click();
    await expect(page.getByText("POST /api/event_logging/batch")).toBeVisible();
  });

  test("permanently blocks a chat session from the Sticky page", async ({ page }) => {
    await page.goto("/sticky");

    const row = page.getByRole("row").filter({ hasText: "sid:e2e-chat-session" });
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Block", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Block chat session" });
    await expect(dialog).toContainText("permanently rejected and cannot be reassigned");
    await dialog.getByRole("button", { name: "Block Session" }).click();

    await expect(page.getByText("Blocked 1 chat sessions")).toBeVisible();
    await expect(row.getByText("Blocked", { exact: true }).first()).toBeVisible();
  });

  test("saves routing settings", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.locator("#strategy").selectOption("round_robin");
    await page.getByRole("button", { name: "Save settings" }).click();

    await expect(page.getByText("Settings saved")).toBeVisible();
    await expect(page.getByText("Strategy: round_robin")).toBeVisible();
  });
});

test.describe("cc-lb mobile navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("routes between primary pages on a narrow viewport", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "Requests", exact: true }).click();
    await expect(page).toHaveURL(/\/requests$/);
    await expect(page.getByRole("heading", { name: "Requests" })).toBeVisible();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });
});

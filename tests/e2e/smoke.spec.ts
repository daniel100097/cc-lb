import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("cc-lb dashboard with seeded data", () => {
  test("renders dashboard health and seeded account states", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Primary healthy", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Rate limited", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Needs reauth", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Requests (7d)", { exact: true })).toBeVisible();
    await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
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

  test("logs telemetry short-circuits into the request table", async ({ page, request }) => {
    const response = await request.post("/api/event_logging/batch", { data: { events: [] } });
    expect(response.ok()).toBe(true);

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

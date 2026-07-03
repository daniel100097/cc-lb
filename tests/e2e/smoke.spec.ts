import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("cc-lb dashboard with seeded data", () => {
  test("renders dashboard health and seeded account states", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Primary healthy" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Rate limited" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Needs reauth" })).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toBeVisible();
    await expect(page.getByText("Requests today", { exact: true })).toBeVisible();
  });

  test("imports credentials and pauses the imported account", async ({ page }) => {
    await page.goto("/accounts");

    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await page.getByRole("button", { name: "Add Account" }).click();

    const dialog = page.getByRole("dialog", { name: "Add Claude account" });
    await dialog.getByLabel("Name").fill("Imported E2E");
    await dialog.getByLabel("Priority").fill("9");
    await dialog.getByRole("textbox", { name: "Credentials JSON" }).fill(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "imported-access",
          refreshToken: "imported-refresh",
          expiresAt: Date.now() + 86_400_000,
          scopes: ["user:inference"],
        },
      }),
    );
    await dialog.getByRole("button", { name: "Import" }).click();

    await expect(page.getByText("Account imported")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "Imported E2E" });
    await expect(row).toBeVisible();
    await row.getByTitle("Pause").click();
    await expect(page.getByText("Account paused")).toBeVisible();
    await expect(row.getByText("Paused")).toBeVisible();
  });

  test("opens OAuth and reauth dialogs without losing generated links", async ({ page }) => {
    await page.goto("/accounts");

    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByRole("tab", { name: "OAuth" }).click();
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Generate login link" }).click();
    const popup = await popupPromise;
    await popup.close();
    await expect(page.getByText("https://claude.ai/oauth/authorize")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("row").filter({ hasText: "Needs reauth" }).getByTitle("Re-authenticate").click();
    const reauthPopupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Generate login link" }).click();
    const reauthPopup = await reauthPopupPromise;
    await reauthPopup.close();
    await expect(page.getByText("https://claude.ai/oauth/authorize")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
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

    await page.getByRole("link", { name: "Requests" }).click();
    await expect(page).toHaveURL(/\/requests$/);
    await expect(page.getByRole("heading", { name: "Requests" })).toBeVisible();

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });
});

import { expect, test } from "@playwright/test";

declare const process: { env: { E2E_BASE_URL?: string } };

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8484";

test.describe("cc-lb smoke with dummy data", () => {
  test("renders dashboard, account OAuth dialogs, and settings", async ({ page }) => {
    await page.goto(baseURL);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Primary healthy")).toBeVisible();
    await expect(page.getByText("Rate limited")).toBeVisible();
    await expect(page.getByText("Needs reauth")).toBeVisible();
    await expect(page.getByText("Available")).toBeVisible();

    await page.getByRole("link", { name: "Accounts" }).click();
    await expect(page).toHaveURL(`${baseURL}/accounts`);
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await expect(page.getByText("OAuth account is missing a refresh token.")).toBeVisible();

    await page.getByRole("button", { name: "Add Account" }).click();
    await page.getByRole("tab", { name: "OAuth" }).click();
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Generate login link" }).click();
    const popup = await popupPromise;
    await popup.close();
    await expect(page.getByText("https://claude.ai/oauth/authorize")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Re-authenticate" }).last().click();
    const reauthPopupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Generate login link" }).click();
    const reauthPopup = await reauthPopupPromise;
    await reauthPopup.close();
    await expect(page.getByText("https://claude.ai/oauth/authorize")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(`${baseURL}/settings`);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.locator("#strategy").selectOption("round_robin");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();
  });
});

import { readFile } from "node:fs/promises";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { parseReplay } from "../claude-sandbox/experiments";

test("records terminal traffic only after opting in, and downloads a replayable session after exit", async ({ page, context }) => {
  const login = await context.request.post("/api/auth/login", {
    data: { password: process.env.E2E_DASHBOARD_PASSWORD || "cc-lb-e2e-password" },
  });
  expect(login.ok()).toBe(true);

  const captureId = "12345678-1234-4234-8234-123456789abc";
  const responseBody = JSON.stringify({
    id: "msg_terminal_sample", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "Recorded response from Claude." }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 8 },
  });
  const exchange = {
    id: "request-1", timestamp: "2026-10-10T12:00:00.000Z", method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    requestHeaders: { authorization: "[redacted]", "content-type": "application/json" },
    requestBody: JSON.stringify({ messages: [{ role: "user", content: "Capture this prompt." }] }),
    responseStatus: 200, responseHeaders: { "content-type": "application/json" },
    responseBody, complete: true, truncated: false,
  };
  let terminalSocket: WebSocketRoute | undefined;
  let connections = 0;
  let plainConnections = 0;
  const inputs: string[] = [];
  let complete = false;
  let endedAt: string | null = null;
  // Terminals start unrecorded; only the switch adds record=1.
  await page.routeWebSocket(/\/api\/accounts\/[^/]+\/terminal$/, (socket) => {
    plainConnections++;
    socket.send(JSON.stringify({ type: "ready" }));
    socket.send(JSON.stringify({ type: "output", data: "Claude terminal ready.\r\n" }));
  });
  await page.routeWebSocket(/\/api\/accounts\/[^/]+\/terminal\?record=1$/, (socket) => {
    terminalSocket = socket;
    connections++;
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "input") inputs.push(message.data);
    });
    socket.send(JSON.stringify({ type: "ready", captureId }));
    socket.send(JSON.stringify({ type: "output", data: "Claude terminal capture ready.\r\n" }));
  });
  await page.route(`**/terminal/traffic/${captureId}`, (route) => route.fulfill({
    json: {
      id: captureId, startedAt: exchange.timestamp, endedAt, truncated: false,
      entries: [complete ? exchange : { ...exchange, responseStatus: null, responseHeaders: {}, responseBody: "", complete: false }],
    },
  }));
  await page.route(`**/terminal/traffic/${captureId}/download`, (route) => route.fulfill({
    headers: {
      "content-type": "application/x-ndjson",
      "content-disposition": `attachment; filename="claude-session-${captureId}.jsonl"`,
    },
    body: `${JSON.stringify(exchange)}\n`,
  }));

  await page.goto("/accounts");
  await page.getByRole("button", { name: "Open Claude terminal for Primary healthy" }).click();
  const dialog = page.getByRole("dialog", { name: "Claude terminal Primary healthy" });
  const panel = dialog.getByRole("region", { name: "Session API traffic" });
  const terminal = dialog.getByLabel("Interactive Claude terminal", { exact: true });
  const request = panel.locator("summary");
  const recordSwitch = dialog.getByRole("switch", { name: "Record API traffic" });
  await expect(terminal).toContainText("Claude terminal ready.");
  await expect(recordSwitch).not.toBeChecked();
  await expect(panel).toHaveCount(0);
  expect(plainConnections).toBe(1);
  expect(connections).toBe(0);

  await recordSwitch.click();
  await expect(recordSwitch).toBeChecked();
  await expect(request).toContainText("Pending POST https://api.anthropic.com/v1/messages");
  await request.click();
  await expect(panel).toContainText("Capture this prompt.");
  await expect(panel).toContainText('"authorization": "[redacted]"');
  await expect(terminal).toBeVisible();

  await dialog.getByRole("button", { name: "Hide traffic (1)" }).click();
  await expect(panel).toBeHidden();
  await terminal.locator("textarea").press("x");
  await expect.poll(() => inputs.join("")).toContain("x");
  await dialog.getByRole("button", { name: "Show traffic (1)" }).click();
  await expect(panel).toBeVisible();
  expect(connections).toBe(1);

  complete = true;
  await expect(request).toContainText("200 POST https://api.anthropic.com/v1/messages");
  await request.click();
  await expect(panel).toContainText("Recorded response from Claude.");
  endedAt = "2026-10-10T12:00:05.000Z";
  if (!terminalSocket) throw new Error("Terminal did not connect");
  terminalSocket.send(JSON.stringify({ type: "exit", code: 0 }));
  await expect(dialog.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await expect(panel).toContainText("Recording ended");

  const downloadLink = dialog.getByRole("link", { name: "Download session" });
  await expect(downloadLink).toHaveAttribute("href", new RegExp(`/terminal/traffic/${captureId}/download$`));
  await expect(downloadLink).toHaveAttribute("download", "");
  // Chromium bypasses page.route for native download links. Let the mocked
  // endpoint's Content-Disposition trigger the download so we can inspect it.
  await downloadLink.evaluate((link) => link.removeAttribute("download"));
  const downloading = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloading;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Session download was not saved");
  const downloaded = await readFile(downloadPath, "utf8");
  expect(download.suggestedFilename()).toBe(`claude-session-${captureId}.jsonl`);
  expect(JSON.parse(downloaded).requestHeaders.authorization).toBe("[redacted]");
  expect(parseReplay(downloaded)).toEqual([{
    responseStatus: 200, responseHeaders: exchange.responseHeaders, responseBody,
  }]);
});

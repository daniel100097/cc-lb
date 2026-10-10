const action = process.argv[2];
try {
  if (action !== "pending" && action !== "reply") throw new Error("Usage: bun tests/claude-sandbox/control.ts pending|reply (reply reads JSON from stdin)");
  const response = await fetch(`http://127.0.0.1:8789/${action}`, {
    method: action === "reply" ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: action === "reply" ? JSON.stringify(JSON.parse(await Bun.stdin.text())) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}

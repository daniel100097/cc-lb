import {
  handleAuthRoute,
  isDashboardAuthenticated,
  loginResponse,
  unauthorizedApiResponse,
} from "./auth";
import { handleTrpc } from "./api/server";
import { startUsageRefresher } from "./anthropic/usage-refresher";
import { servicePorts } from "./ports";
import { handleProxy } from "./proxy/handler";

const { dashboard: DASHBOARD_PORT, proxy: PROXY_PORT } = servicePorts();

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const TELEMETRY_PATHS = new Set(["/api/event_logging/batch", "/api/system/package-manager"]);

startUsageRefresher();

const dashboardServer = Bun.serve({
  port: DASHBOARD_PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return healthResponse("cc-lb-dashboard");
    }

    if (TELEMETRY_PATHS.has(url.pathname)) {
      return Response.json({ error: "proxy_port_required", proxyPort: PROXY_PORT }, { status: 404 });
    }

    const authResponse = await handleAuthRoute(req, url);
    if (authResponse) return authResponse;

    if (url.pathname.startsWith("/api/trpc")) {
      if (!isDashboardAuthenticated(req)) return unauthorizedApiResponse();
      return handleTrpc(req);
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isDashboardAuthenticated(req)) return unauthorizedApiResponse();
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Proxy traffic is intentionally unavailable on the dashboard listener.
    if (url.pathname.startsWith("/v1/")) {
      return Response.json({ error: "proxy_port_required", proxyPort: PROXY_PORT }, { status: 404 });
    }

    if (!isDashboardAuthenticated(req)) {
      return loginResponse(url, false);
    }

    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(PUBLIC_DIR + filePath.replace(/^\//, ""));
    if (await file.exists()) return new Response(file);

    const index = Bun.file(PUBLIC_DIR + "index.html");
    if (await index.exists()) return new Response(index);

    return new Response("cc-lb dashboard running. Build the frontend to see it.", {
      headers: { "content-type": "text/plain" },
    });
  },
});

const proxyServer = Bun.serve({
  port: PROXY_PORT,
  // Quiet SSE streams can exceed Bun's idle-timeout ceiling; disable the
  // request timer for proxy traffic after accepting it.
  idleTimeout: 255,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return healthResponse("cc-lb-proxy");
    }

    if (url.pathname.startsWith("/v1/") || TELEMETRY_PATHS.has(url.pathname)) {
      server.timeout(req, 0);
      return handleProxy(req, url);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`cc-lb dashboard listening on http://localhost:${dashboardServer.port}`);
console.log(`cc-lb proxy listening on http://localhost:${proxyServer.port}`);

function healthResponse(service: "cc-lb-dashboard" | "cc-lb-proxy"): Response {
  return Response.json({ ok: true, service, time: Date.now() });
}

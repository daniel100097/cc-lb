import { handleTrpc } from "./api/server";
import { handleProxy } from "./proxy/handler";

const PORT = Number(process.env.PORT ?? 8484);
const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const TELEMETRY_PATHS = new Set(["/api/event_logging/batch", "/api/system/package-manager"]);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Liveness
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "cc-lb", time: Date.now() });
    }

    if (url.pathname.startsWith("/api/trpc")) {
      return handleTrpc(req);
    }

    if (url.pathname.startsWith("/v1/") || TELEMETRY_PATHS.has(url.pathname)) {
      return handleProxy(req, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    // Static SPA (built by Bun into ../public); fall back to index.html.
    const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(PUBLIC_DIR + filePath.replace(/^\//, ""));
    if (await file.exists()) return new Response(file);

    const index = Bun.file(PUBLIC_DIR + "index.html");
    if (await index.exists()) return new Response(index);

    return new Response("cc-lb running. Build the frontend to see the dashboard.", {
      headers: { "content-type": "text/plain" },
    });
  },
});

console.log(`cc-lb listening on http://localhost:${server.port}`);

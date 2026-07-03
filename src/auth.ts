import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "cc_lb_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function dashboardPassword(): string | null {
  const password = process.env.DASHBOARD_PASSWORD;
  return password && password.length > 0 ? password : null;
}

export function isDashboardAuthEnabled(): boolean {
  return dashboardPassword() !== null;
}

function sessionToken(password: string): string {
  return createHmac("sha256", password).update("cc-lb-dashboard-session-v1").digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawKey, rawValue] = part.trim().split("=");
    if (rawKey === name && rawValue !== undefined) return decodeURIComponent(rawValue);
  }
  return null;
}

function authorizationCredential(req: Request): string | null {
  const authorization = req.headers.get("authorization");
  if (!authorization) return null;

  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return separator >= 0 ? decoded.slice(separator + 1) : decoded;
    } catch {
      return null;
    }
  }

  return null;
}

export function isDashboardAuthenticated(req: Request): boolean {
  const password = dashboardPassword();
  if (!password) return true;

  const expected = sessionToken(password);
  const cookie = cookieValue(req, SESSION_COOKIE);
  if (cookie && safeEqual(cookie, expected)) return true;

  const credential = authorizationCredential(req);
  if (!credential) return false;
  return safeEqual(credential, password) || safeEqual(credential, expected);
}

export async function handleAuthRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/auth/")) return null;

  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    return Response.json({
      enabled: isDashboardAuthEnabled(),
      authenticated: isDashboardAuthenticated(req),
    });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      },
    });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const password = dashboardPassword();
    if (!password) return Response.json({ ok: true });

    const submitted = await submittedPassword(req);
    if (!submitted || !safeEqual(submitted, password)) {
      return loginResponse(url, false);
    }

    const headers = new Headers({
      "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(sessionToken(password))}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`,
    });
    const acceptsHtml = req.headers.get("accept")?.includes("text/html") ?? false;
    if (acceptsHtml) {
      headers.set("location", "/");
      return new Response(null, { status: 303, headers });
    }
    return Response.json({ ok: true }, { headers });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

async function submittedPassword(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await req.json();
    if (typeof body === "object" && body !== null && "password" in body) {
      const password = body.password;
      return typeof password === "string" ? password : null;
    }
    return null;
  }

  const form = await req.formData();
  const password = form.get("password");
  return typeof password === "string" ? password : null;
}

export function unauthorizedApiResponse(): Response {
  return Response.json(
    { error: "unauthorized", message: "Dashboard authentication required." },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
}

export function loginResponse(url: URL, authenticated = true): Response {
  if (!isDashboardAuthEnabled() || authenticated) {
    return new Response(null, { status: 303, headers: { location: "/" } });
  }

  return new Response(loginHtml(url), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function loginHtml(url: URL): string {
  const failed = url.searchParams.get("failed") === "1";
  const error = failed ? `<p class="error">Invalid password.</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CC-LB Login</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
      main { width: min(92vw, 360px); border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; background: white; box-shadow: 0 16px 40px rgb(15 23 42 / 0.08); }
      h1 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0 0 20px; color: #64748b; font-size: 14px; }
      label { display: grid; gap: 8px; font-size: 13px; font-weight: 600; }
      input { height: 38px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0 10px; font: inherit; }
      button { width: 100%; height: 38px; margin-top: 16px; border: 0; border-radius: 6px; background: #4f46e5; color: white; font: inherit; font-weight: 600; cursor: pointer; }
      .error { color: #dc2626; margin-bottom: 12px; }
      @media (prefers-color-scheme: dark) {
        body { background: #020617; color: #f8fafc; }
        main { background: #09090b; border-color: #27272a; }
        input { background: #111827; color: #f8fafc; border-color: #374151; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>CC-LB</h1>
      <p>Dashboard password required.</p>
      ${error}
      <form method="post" action="/api/auth/login" enctype="application/x-www-form-urlencoded">
        <label>
          Password
          <input name="password" type="password" autocomplete="current-password" autofocus />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`;
}

export const DEFAULT_DASHBOARD_PORT = 8484;
export const DEFAULT_PROXY_PORT = 8485;

export function dashboardPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort("DASHBOARD_PORT", env.DASHBOARD_PORT ?? env.PORT, DEFAULT_DASHBOARD_PORT);
}

export function proxyPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePort("PROXY_PORT", env.PROXY_PORT, DEFAULT_PROXY_PORT);
}

export function servicePorts(env: NodeJS.ProcessEnv = process.env): {
  dashboard: number;
  proxy: number;
} {
  const dashboard = dashboardPort(env);
  const proxy = proxyPort(env);
  if (dashboard === proxy) throw new Error("DASHBOARD_PORT and PROXY_PORT must be different");
  return { dashboard, proxy };
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  const port = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

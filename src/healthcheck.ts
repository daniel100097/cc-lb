import { servicePorts } from "./ports";

// Docker HEALTHCHECK: both isolated listeners must answer their health route.
const ports = servicePorts();

try {
  const [dashboard, proxy] = await Promise.all([
    fetch(`http://localhost:${ports.dashboard}/api/health`),
    fetch(`http://localhost:${ports.proxy}/api/health`),
  ]);
  process.exit(dashboard.ok && proxy.ok ? 0 : 1);
} catch {
  process.exit(1);
}

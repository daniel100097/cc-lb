// Docker HEALTHCHECK: exit 0 if the server answers /api/health.
const port = Number(process.env.PORT ?? 8484);
try {
  const res = await fetch(`http://localhost:${port}/api/health`);
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}

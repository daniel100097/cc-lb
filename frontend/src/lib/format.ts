export function relativeTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Never";
  const deltaMs = value - Date.now();
  const abs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? "from now" : "ago";
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days}d ${suffix}`;
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

export function durationMs(value: number): string {
  const minutes = Math.round(value / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr`;
}

export function latencyMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function currency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 0.01 ? 5 : 3,
  }).format(value);
}

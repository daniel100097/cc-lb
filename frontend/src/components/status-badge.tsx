import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusClassMap = new Map([
  ["active", "bg-emerald-500/15 text-emerald-700 border-emerald-500/20 dark:text-emerald-400"],
  ["paused", "bg-amber-500/15 text-amber-700 border-amber-500/20 dark:text-amber-400"],
  ["rate_limited", "bg-orange-500/15 text-orange-700 border-orange-500/20 dark:text-orange-400"],
  ["needs_reauth", "bg-sky-500/15 text-sky-700 border-sky-500/20 dark:text-sky-300"],
  ["expired", "bg-zinc-500/15 text-zinc-600 border-zinc-500/20 dark:text-zinc-400"],
  ["ok", "bg-emerald-500/15 text-emerald-700 border-emerald-500/20 dark:text-emerald-400"],
  ["telemetry", "bg-zinc-500/15 text-zinc-600 border-zinc-500/20 dark:text-zinc-400"],
  ["unauthorized", "bg-sky-500/15 text-sky-700 border-sky-500/20 dark:text-sky-300"],
  ["network_error", "bg-red-500/15 text-red-700 border-red-500/20 dark:text-red-400"],
  ["token_error", "bg-red-500/15 text-red-700 border-red-500/20 dark:text-red-400"],
  ["upstream_error", "bg-red-500/15 text-red-700 border-red-500/20 dark:text-red-400"],
]);

const labelMap = new Map([
  ["active", "Active"],
  ["paused", "Paused"],
  ["rate_limited", "Rate limited"],
  ["needs_reauth", "Needs reauth"],
  ["expired", "Expired"],
  ["ok", "OK"],
  ["telemetry", "Telemetry"],
  ["unauthorized", "Unauthorized"],
  ["network_error", "Network error"],
  ["token_error", "Token error"],
  ["upstream_error", "Upstream error"],
]);

export function StatusBadge({ status }: { status: string }) {
  const className = statusClassMap.get(status) ?? statusClassMap.get("expired");
  return (
    <Badge className={cn("gap-1.5", className)} variant="outline">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {labelMap.get(status) ?? status}
    </Badge>
  );
}

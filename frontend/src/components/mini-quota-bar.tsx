import { Clock } from "lucide-react";

import { resetCountdown } from "@/lib/format";

export function QuotaWindowMeter({
  label,
  percentRemaining,
  resetAt,
}: {
  label: string;
  percentRemaining: number | null | undefined;
  resetAt: number | null | undefined;
}) {
  const pct = percentRemaining === null || percentRemaining === undefined ? null : Math.max(0, Math.min(100, percentRemaining));
  const countdown = resetCountdown(resetAt);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-primary font-semibold tabular-nums">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
      </div>
      <div className="bg-muted mt-1.5 h-1.5 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: pct === null ? 0 : `${Math.max(4, pct)}%` }} />
      </div>
      <div className="text-muted-foreground mt-1.5 flex items-center gap-1 text-xs">
        <Clock className="size-3 shrink-0" />
        <span className="truncate">{countdown ?? "—"}</span>
      </div>
    </div>
  );
}

export function MiniQuotaBar({ percentRemaining }: { percentRemaining: number | null | undefined }) {
  if (percentRemaining === null || percentRemaining === undefined) {
    return <span className="text-muted-foreground text-xs">Unknown</span>;
  }

  const pct = Math.max(0, Math.min(100, percentRemaining));
  return (
    <div className="flex min-w-24 items-center gap-2">
      <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <span className="text-muted-foreground w-8 text-right text-xs">{Math.round(pct)}%</span>
    </div>
  );
}

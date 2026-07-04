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

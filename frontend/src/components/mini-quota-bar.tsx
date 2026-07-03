export function MiniQuotaBar({ remaining }: { remaining: number | null | undefined }) {
  if (remaining === null || remaining === undefined) {
    return <span className="text-muted-foreground text-xs">Unknown</span>;
  }

  const pct = Math.max(4, Math.min(100, remaining));
  return (
    <div className="flex min-w-24 items-center gap-2">
      <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-muted-foreground w-8 text-right text-xs">{remaining}</span>
    </div>
  );
}

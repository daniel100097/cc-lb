import { useMemo, useState } from "react";
import { usePrivacyStore } from "@/hooks/use-privacy";
import { compactNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export type DonutChartItem = {
  id?: string;
  label: string;
  labelSuffix?: string;
  isEmail?: boolean;
  value: number;
  color?: string;
};

export type DonutChartProps = {
  items: DonutChartItem[];
  total: number;
  centerValue?: number;
  title: string;
  subtitle?: string;
  centerLayout?: "remaining" | "credits" | "currency";
};

const PALETTE = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#ca8a04",
  "#7c3aed",
  "#0891b2",
  "#e11d48",
  "#4f46e5",
];

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function formatCenterValue(value: number, layout: DonutChartProps["centerLayout"]): string {
  if (layout === "currency") {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value < 1 ? 3 : 2,
    }).format(value);
  }
  if (layout === "credits" && value < 1_000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  }
  return compactNumber(value);
}

export function DonutChart({
  items,
  total,
  centerValue,
  title,
  subtitle,
  centerLayout = "remaining",
}: DonutChartProps) {
  const blurNames = usePrivacyStore((state) => state.blurNames);
  const [activeId, setActiveId] = useState<string | null>(null);
  const radius = 41;
  const circumference = 2 * Math.PI * radius;
  const positiveTotal = Math.max(0, total);

  const normalized = useMemo(
    () =>
      items
        .map((item, index) => ({
          ...item,
          id: item.id ?? item.label,
          color: item.color ?? PALETTE[index % PALETTE.length],
          value: Math.max(0, Number.isFinite(item.value) ? item.value : 0),
        }))
        .filter((item) => item.value > 0),
    [items],
  );
  const visibleTotal = normalized.reduce((sum, item) => sum + item.value, 0);
  const used = Math.max(0, positiveTotal - visibleTotal);
  const chartTotal = Math.max(visibleTotal + used, positiveTotal, 1);
  const chartItems = [
    ...normalized,
    ...(used > 0
      ? [{ id: "__used__", label: "Used", labelSuffix: "", isEmail: false, value: used, color: "currentColor" }]
      : []),
  ];
  const displayValue = Math.max(0, centerValue ?? visibleTotal);
  let offset = 0;

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle ? <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p> : null}
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative mx-auto size-40 shrink-0 text-muted sm:mx-0">
          <svg aria-hidden="true" className="size-40 -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" fill="none" r={radius} stroke="currentColor" strokeWidth="11" />
            {chartItems.length > 0 ? (
              chartItems.map((item) => {
                const length = (item.value / chartTotal) * circumference;
                const gapAdjusted = Math.max(0, length - 1.8);
                const dashOffset = -offset;
                offset += length;
                return (
                  <circle
                    key={item.id}
                    cx="50"
                    cy="50"
                    fill="none"
                    r={radius}
                    stroke={item.color}
                    strokeDasharray={`${gapAdjusted} ${circumference - gapAdjusted}`}
                    strokeDashoffset={dashOffset}
                    strokeLinecap="round"
                    strokeOpacity={activeId && activeId !== item.id ? 0.35 : 1}
                    strokeWidth={activeId === item.id ? 13 : 11}
                  />
                );
              })
            ) : (
              <circle cx="50" cy="50" fill="none" r={radius} stroke="currentColor" strokeWidth="11" />
            )}
          </svg>
          <div className="absolute inset-6 flex items-center justify-center rounded-full text-center">
            <div className="min-w-0">
              <p className="text-muted-foreground text-[10px] font-medium uppercase">
                {centerLayout === "currency" ? "Cost" : centerLayout === "credits" ? "Credits" : "Remaining"}
              </p>
              <p className="mt-0.5 text-base font-semibold tabular-nums">{formatCenterValue(displayValue, centerLayout)}</p>
              {centerLayout === "credits" && positiveTotal > 0 ? (
                <p className="text-muted-foreground text-[11px] tabular-nums">of {compactNumber(positiveTotal)}</p>
              ) : null}
            </div>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          {chartItems.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-sm">No chart data</div>
          ) : (
            chartItems.map((item) => {
              const share = chartTotal > 0 ? (item.value / chartTotal) * 100 : 0;
              const label = `${item.label}${item.labelSuffix ?? ""}`;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    "flex h-8 w-full min-w-0 items-center justify-between gap-3 rounded-md border border-transparent px-2 text-left text-xs transition-colors hover:bg-muted/50",
                    activeId === item.id && "border-border bg-muted/50",
                  )}
                  onBlur={() => setActiveId(null)}
                  onFocus={() => setActiveId(item.id)}
                  onMouseEnter={() => setActiveId(item.id)}
                  onMouseLeave={() => setActiveId(null)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className={cn("truncate font-medium", item.isEmail && blurNames && "privacy-blur")}>{label}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {formatCenterValue(item.value, centerLayout)} · {formatPercent(share)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

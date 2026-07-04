export type SparklineChartProps = {
  data: { value: number }[];
  color?: string;
  index?: number;
  height?: number;
};

function pathFromPoints(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

export function SparklineChart({ data, color = "currentColor", index = 0, height = 40 }: SparklineChartProps) {
  const values = data.length > 0 ? data.map((point) => point.value) : [0, 0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 100;
  const chartHeight = 32;
  const points = values.map((value, pointIndex) => ({
    x: values.length === 1 ? width / 2 : (pointIndex / (values.length - 1)) * width,
    y: chartHeight - ((value - min) / span) * (chartHeight - 4) + 2,
  }));
  const linePath = pathFromPoints(points);
  const fillPath = points.length > 0 ? `${linePath} L ${width} ${chartHeight} L 0 ${chartHeight} Z` : "";
  const gradientId = `sparkline-gradient-${index}`;

  return (
    <svg
      aria-hidden="true"
      className="block w-full overflow-visible"
      height={height}
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} ${chartHeight}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

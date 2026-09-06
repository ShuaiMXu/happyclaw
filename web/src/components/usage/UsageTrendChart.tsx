import { formatTokens } from '../billing/utils';

export type UsageTrendMetric = 'tokens' | 'cost' | 'runs';

export interface DailyUsagePoint {
  date: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number | null;
  runCount: number;
  modelCallCount: number;
}

const TOKEN_SERIES = [
  ['inputTokens', '普通输入', 'var(--chart-1)'],
  ['cacheReadTokens', '缓存读取', 'var(--chart-2)'],
  ['cacheCreationTokens', '缓存写入', 'var(--chart-3)'],
  ['outputTokens', '输出', 'var(--chart-4)'],
  ['reasoningTokens', '推理', 'var(--chart-5)'],
] as const;

const WIDTH = 1000;
const HEIGHT = 300;
const LEFT = 76;
const RIGHT = 16;
const TOP = 34;
const BOTTOM = 38;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const GRID_STEPS = 4;

function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

function metricValue(point: DailyUsagePoint, metric: UsageTrendMetric): number {
  if (metric === 'tokens') return point.totalTokens;
  if (metric === 'cost') return point.providerEstimatedCostUSD;
  return point.runCount;
}

function niceMaximum(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function UsageTrendChart({
  data,
  metric,
}: {
  data: DailyUsagePoint[];
  metric: UsageTrendMetric;
}) {
  const formatValue = (value: number) => {
    if (metric === 'tokens') return formatTokens(value);
    if (metric === 'cost') return formatCost(value);
    return new Intl.NumberFormat('zh-CN').format(value);
  };
  const ariaLabel =
    metric === 'tokens'
      ? '每日 Token 趋势图，按普通输入、缓存读取、缓存写入、输出和推理堆叠展示'
      : metric === 'cost'
        ? '每日模型估算费用趋势图'
        : '每日智能体运行次数趋势图';
  const maximum = niceMaximum(
    Math.max(0, ...data.map((point) => metricValue(point, metric))),
  );
  const slotWidth = data.length > 0 ? PLOT_WIDTH / data.length : PLOT_WIDTH;
  const barWidth = Math.max(2, Math.min(42, slotWidth * 0.72));
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <div className="h-72 min-w-0 lg:h-80">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-full w-full overflow-visible"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        {Array.from({ length: GRID_STEPS + 1 }, (_, index) => {
          const ratio = index / GRID_STEPS;
          const y = TOP + PLOT_HEIGHT * ratio;
          const value = maximum * (1 - ratio);
          return (
            <g key={index}>
              <line
                x1={LEFT}
                x2={WIDTH - RIGHT}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="4 5"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={LEFT - 10}
                y={y + 4}
                textAnchor="end"
                fill="var(--muted-foreground)"
                fontSize="11"
              >
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        {data.map((point, index) => {
          const x = LEFT + slotWidth * index + (slotWidth - barWidth) / 2;
          const label =
            metric === 'tokens'
              ? TOKEN_SERIES.map(
                  ([key, name]) => `${name} ${formatValue(point[key])}`,
                ).join('，')
              : metric === 'cost'
                ? `模型估算费用 ${formatValue(point.providerEstimatedCostUSD)}`
                : `智能体运行次数 ${formatValue(point.runCount)}`;
          let stackedBottom = TOP + PLOT_HEIGHT;

          return (
            <g key={point.date}>
              <title>{`${point.date}：${label}`}</title>
              {metric === 'tokens' ? (
                TOKEN_SERIES.map(([key, , color], seriesIndex) => {
                  const height = (point[key] / maximum) * PLOT_HEIGHT;
                  stackedBottom -= height;
                  return (
                    <rect
                      key={key}
                      x={x}
                      y={stackedBottom}
                      width={barWidth}
                      height={Math.max(0, height)}
                      rx={seriesIndex === TOKEN_SERIES.length - 1 ? 3 : 0}
                      fill={color}
                    />
                  );
                })
              ) : (
                <rect
                  x={x}
                  y={
                    TOP +
                    PLOT_HEIGHT * (1 - metricValue(point, metric) / maximum)
                  }
                  width={barWidth}
                  height={(metricValue(point, metric) / maximum) * PLOT_HEIGHT}
                  rx={4}
                  fill="var(--color-primary)"
                />
              )}
              {index % labelEvery === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={HEIGHT - 14}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize="11"
                >
                  {point.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}

        {metric === 'tokens' &&
          TOKEN_SERIES.map(([, label, color], index) => (
            <g key={label} transform={`translate(${LEFT + index * 112}, 10)`}>
              <circle cx="4" cy="4" r="4" fill={color} />
              <text x="13" y="8" fill="var(--muted-foreground)" fontSize="12">
                {label}
              </text>
            </g>
          ))}

        {data.length === 0 && (
          <text
            x={WIDTH / 2}
            y={HEIGHT / 2}
            textAnchor="middle"
            fill="var(--muted-foreground)"
            fontSize="14"
          >
            暂无趋势数据
          </text>
        )}
      </svg>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th>日期</th>
            <th>数值</th>
          </tr>
        </thead>
        <tbody>
          {data.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td>{formatValue(metricValue(point, metric))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

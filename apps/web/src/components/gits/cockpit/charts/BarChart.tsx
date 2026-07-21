import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";

import { CHART_SERIES_STYLE, seriesVar } from "./chartTheme";
import { formatCompactValue, niceTicks, roundedTopBarPath, stackValues } from "./scale.logic";

export interface BarSegmentValue {
  readonly key: string;
  readonly value: number;
}

export interface BarDatum {
  readonly label: string;
  readonly values: readonly BarSegmentValue[];
}

export interface BarChartProps {
  readonly data: readonly BarDatum[];
  readonly height?: number;
  readonly unit?: string;
}

const VIEW_W = 600;
const PAD = { top: 10, right: 10, bottom: 22, left: 34 };
const GAP = 2;
const RADIUS = 4;

interface HoverState {
  readonly index: number;
  readonly left: number;
}

export function BarChart({ data, height = 160, unit }: BarChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const stacks = data.map((d) => stackValues(d.values));
  const totals = stacks.map((segments) => segments.at(-1)?.end ?? 0);
  const maxTotal = Math.max(0, ...totals);
  const yTicks = niceTicks(0, maxTotal, 3);
  const maxV = yTicks.at(-1) ?? 1;
  const baselineY = height - PAD.bottom;
  const yScale = (v: number) =>
    maxV === 0 ? baselineY : baselineY - (v / maxV) * (baselineY - PAD.top);

  const bandWidth = data.length > 0 ? (VIEW_W - PAD.left - PAD.right) / data.length : 0;
  const barWidth = Math.max(1, bandWidth - GAP);
  const legendKeys = data[0]?.values.map((v) => v.key) ?? [];
  const showLegend = legendKeys.length >= 2;

  const summary = data
    .map((d) => {
      const total = d.values.reduce((sum, v) => sum + v.value, 0);
      return `${d.label} ${formatCompactValue(total, unit)}`;
    })
    .join(", ");

  function openTooltip(index: number, clientX: number) {
    const rect = wrapperRef.current?.getBoundingClientRect();
    setHover({ index, left: rect ? clientX - rect.left : 0 });
  }

  function handlePointerMove(index: number, event: ReactPointerEvent<SVGRectElement>) {
    openTooltip(index, event.clientX);
  }

  function handleFocus(index: number, event: ReactFocusEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    openTooltip(index, rect.left + rect.width / 2);
  }

  return (
    <div
      ref={wrapperRef}
      role="img"
      aria-label={data.length > 0 ? `Bar chart: ${summary}` : "Bar chart: no data"}
      className="relative w-full select-none"
      style={CHART_SERIES_STYLE}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        aria-hidden="true"
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={VIEW_W - PAD.right}
              y1={yScale(tick)}
              y2={yScale(tick)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={yScale(tick)}
              dy={3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px]"
            >
              {formatCompactValue(tick, unit)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const segments = stacks[i]!;
          const x = PAD.left + i * bandWidth + (bandWidth - barWidth) / 2;
          const isHovered = hover?.index === i;
          return (
            <g key={d.label} style={isHovered ? { filter: "brightness(1.15)" } : undefined}>
              {segments.map((seg, j) => {
                const isTop = j === segments.length - 1;
                let yTop = yScale(seg.end);
                let yBottom = yScale(seg.start);
                if (j > 0) yBottom -= GAP / 2;
                if (!isTop) yTop += GAP / 2;
                return isTop ? (
                  <path
                    key={seg.key}
                    d={roundedTopBarPath(x, barWidth, yTop, yBottom, RADIUS)}
                    fill={seriesVar(j)}
                  />
                ) : (
                  <rect
                    key={seg.key}
                    x={x}
                    y={yTop}
                    width={barWidth}
                    height={Math.max(0, yBottom - yTop)}
                    fill={seriesVar(j)}
                  />
                );
              })}
            </g>
          );
        })}

        {data.map((d, i) => {
          const x = PAD.left + i * bandWidth + (bandWidth - barWidth) / 2;
          return (
            <rect
              key={d.label}
              x={x}
              y={PAD.top}
              width={barWidth}
              height={baselineY - PAD.top}
              fill="transparent"
              tabIndex={0}
              onPointerMove={(event) => handlePointerMove(i, event)}
              onPointerLeave={() => setHover(null)}
              onFocus={(event) => handleFocus(i, event)}
              onBlur={() => setHover(null)}
            />
          );
        })}

        {data.map((d, i) => (
          <text
            key={d.label}
            x={PAD.left + i * bandWidth + bandWidth / 2}
            y={height - 6}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {d.label}
          </text>
        ))}
      </svg>

      {showLegend ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {legendKeys.map((key, i) => (
            <span key={key} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: seriesVar(i) }} />
              {key}
            </span>
          ))}
        </div>
      ) : null}

      {hover ? (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-28 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: hover.left + 10 }}
        >
          <div className="mb-1 truncate text-[10px] text-muted-foreground">
            {data[hover.index]!.label}
          </div>
          <div className="flex flex-col gap-0.5">
            {data[hover.index]!.values.map((v, i) => (
              <div key={v.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate">
                  <span className="size-2 rounded-[2px]" style={{ background: seriesVar(i) }} />
                  {v.key}
                </span>
                <span className="font-mono tabular-nums font-semibold">
                  {formatCompactValue(v.value, unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

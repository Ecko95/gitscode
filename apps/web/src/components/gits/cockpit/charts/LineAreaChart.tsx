import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";

import { CHART_SERIES_STYLE, seriesVar } from "./chartTheme";
import {
  buildAreaPath,
  buildLinePath,
  formatAxisTime,
  formatCompactValue,
  linearScale,
  nearestIndexByT,
  niceTicks,
} from "./scale.logic";

export interface LineAreaPoint {
  readonly t: number;
  readonly v: number;
}

export interface LineAreaSeries {
  readonly id: string;
  readonly label: string;
  readonly points: readonly LineAreaPoint[];
}

export interface LineAreaChartProps {
  readonly series: readonly LineAreaSeries[];
  readonly height?: number;
  readonly unit?: string;
  readonly showLegend?: boolean;
}

const VIEW_W = 600;
const PAD = { top: 10, right: 10, bottom: 18, left: 34 };

interface HoverState {
  readonly clientX: number;
  readonly t: number;
}

export function LineAreaChart({ series, height = 160, unit, showLegend }: LineAreaChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const allPoints = series.flatMap((s) => s.points);
  const hasData = allPoints.length > 0;
  const minT = hasData ? Math.min(...allPoints.map((p) => p.t)) : 0;
  const maxT = hasData ? Math.max(...allPoints.map((p) => p.t)) : 1;
  const rawMinV = hasData ? Math.min(0, ...allPoints.map((p) => p.v)) : 0;
  const rawMaxV = hasData ? Math.max(...allPoints.map((p) => p.v)) : 1;
  const yTicks = niceTicks(rawMinV, rawMaxV, 3);
  const minV = yTicks[0]!;
  const maxV = yTicks.at(-1)!;

  const xScale = linearScale([minT, maxT], [PAD.left, VIEW_W - PAD.right]);
  const xInvert = linearScale([PAD.left, VIEW_W - PAD.right], [minT, maxT]);
  const yScale = linearScale([minV, maxV], [height - PAD.bottom, PAD.top]);

  const legend = showLegend ?? series.length >= 2;
  const spanMs = maxT - minT;

  const seriesPaths = series.map((s) => {
    const pixelPoints = s.points.map((p) => ({ x: xScale(p.t), y: yScale(p.v) }));
    return { series: s, pixelPoints };
  });

  const summary = series
    .map((s) => {
      const last = s.points.at(-1);
      return last ? `${s.label} ${formatCompactValue(last.v, unit)}` : s.label;
    })
    .join(", ");

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!hasData) return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const viewBoxX = PAD.left + fraction * (VIEW_W - PAD.left - PAD.right);
    const t = Math.min(maxT, Math.max(minT, xInvert(viewBoxX)));
    setHover({ clientX: event.clientX, t });
  }

  const hoverX = hover ? xScale(hover.t) : null;
  const wrapperRect = wrapperRef.current?.getBoundingClientRect();
  const tooltipLeft = hover && wrapperRect ? hover.clientX - wrapperRect.left : 0;
  const tooltipAlignEnd = wrapperRect ? tooltipLeft > wrapperRect.width / 2 : false;

  return (
    <div
      ref={wrapperRef}
      role="img"
      aria-label={hasData ? `Line chart: ${summary}` : "Line chart: no data"}
      className="relative w-full select-none"
      style={CHART_SERIES_STYLE}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(null)}
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

        {hasData ? (
          <>
            <text
              x={PAD.left}
              y={height - 4}
              textAnchor="start"
              className="fill-muted-foreground text-[9px]"
            >
              {formatAxisTime(minT, spanMs)}
            </text>
            <text
              x={VIEW_W - PAD.right}
              y={height - 4}
              textAnchor="end"
              className="fill-muted-foreground text-[9px]"
            >
              {formatAxisTime(maxT, spanMs)}
            </text>
          </>
        ) : null}

        {seriesPaths.map(({ series: s, pixelPoints }, i) => (
          <g key={s.id}>
            <path
              d={buildAreaPath(pixelPoints, height - PAD.bottom)}
              fill={seriesVar(i)}
              fillOpacity={0.1}
            />
            <path
              d={buildLinePath(pixelPoints)}
              stroke={seriesVar(i)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
            />
            {pixelPoints.length > 0 ? (
              <circle
                cx={pixelPoints.at(-1)!.x}
                cy={pixelPoints.at(-1)!.y}
                r={4}
                fill={seriesVar(i)}
                className="stroke-card"
                strokeWidth={2}
              />
            ) : null}
          </g>
        ))}

        {hover && hoverX !== null ? (
          <>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PAD.top}
              y2={height - PAD.bottom}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeOpacity={0.4}
            />
            {seriesPaths.map(({ series: s, pixelPoints }, i) => {
              if (pixelPoints.length === 0) return null;
              const idx = nearestIndexByT(s.points, hover.t);
              const point = pixelPoints[idx]!;
              return (
                <circle
                  key={s.id}
                  cx={point.x}
                  cy={point.y}
                  r={4}
                  fill={seriesVar(i)}
                  className="stroke-card"
                  strokeWidth={2}
                />
              );
            })}
          </>
        ) : null}
      </svg>

      {!legend && series.length === 1 && series[0]!.points.length > 0 ? (
        <div className="pointer-events-none absolute top-1 right-2.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="size-1.5 rounded-full" style={{ background: seriesVar(0) }} />
          {series[0]!.label}
          {series[0]!.points.at(-1) ? (
            <span className="font-mono tabular-nums text-foreground">
              {formatCompactValue(series[0]!.points.at(-1)!.v, unit)}
            </span>
          ) : null}
        </div>
      ) : null}

      {legend ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {series.map((s, i) => (
            <span key={s.id} className="flex items-center gap-1.5">
              <svg width={12} height={2} aria-hidden="true">
                <line x1={0} x2={12} y1={1} y2={1} stroke={seriesVar(i)} strokeWidth={2} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      ) : null}

      {hover && hasData ? (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-28 rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{
            left: tooltipAlignEnd ? undefined : tooltipLeft + 10,
            right:
              tooltipAlignEnd && wrapperRect ? wrapperRect.width - tooltipLeft + 10 : undefined,
          }}
        >
          <div className="mb-1 text-[10px] text-muted-foreground">
            {formatAxisTime(hover.t, spanMs)}
          </div>
          <div className="flex flex-col gap-0.5">
            {seriesPaths.map(({ series: s }, i) => {
              const idx = nearestIndexByT(s.points, hover.t);
              const point = s.points[idx];
              return (
                <div key={s.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 truncate">
                    <svg width={10} height={2} aria-hidden="true">
                      <line x1={0} x2={10} y1={1} y2={1} stroke={seriesVar(i)} strokeWidth={2} />
                    </svg>
                    {s.label}
                  </span>
                  <span className="font-mono tabular-nums font-semibold">
                    {point ? formatCompactValue(point.v, unit) : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

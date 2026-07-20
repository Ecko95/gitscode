import { ArrowDownRightIcon, ArrowUpRightIcon, type CircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { type ChartTone, CHART_TONE_STROKE, CHART_TONE_TEXT } from "./chartTheme";
import { buildLinePath, formatCompactValue, linearScale } from "./scale.logic";

export interface StatTileDelta {
  readonly value: number;
  /** Which direction counts as "good" — flips the success/danger color. Default "up". */
  readonly goodDirection?: "up" | "down";
}

export interface StatTileProps {
  readonly label: string;
  readonly value: string | number;
  readonly icon?: typeof CircleIcon;
  readonly tone?: ChartTone;
  readonly delta?: StatTileDelta;
  readonly sparkline?: readonly number[];
}

const SPARK_W = 64;
const SPARK_H = 20;

export function StatTile({
  label,
  value,
  icon: Icon,
  tone = "default",
  delta,
  sparkline,
}: StatTileProps) {
  const displayValue = typeof value === "number" ? formatCompactValue(value) : value;
  const deltaIsGood = delta
    ? (delta.goodDirection ?? "up") === (delta.value >= 0 ? "up" : "down")
    : false;
  const deltaTone: ChartTone = deltaIsGood ? "success" : "danger";
  const DeltaIcon = delta && delta.value >= 0 ? ArrowUpRightIcon : ArrowDownRightIcon;
  const deltaText = delta
    ? `${delta.value >= 0 ? "+" : ""}${formatCompactValue(delta.value)}%`
    : null;

  const sparkPoints =
    sparkline && sparkline.length > 1
      ? sparkline.map((v, i) => ({
          x: linearScale([0, sparkline.length - 1], [1, SPARK_W - 1])(i),
          y: linearScale([Math.min(...sparkline), Math.max(...sparkline)], [SPARK_H - 2, 2])(v),
        }))
      : null;

  const summary = `${label}: ${displayValue}${deltaText ? `, ${deltaText}` : ""}`;

  return (
    <div
      role="img"
      aria-label={summary}
      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-4 py-3"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground/70">
          {Icon ? <Icon className={cn("size-3.5 shrink-0", CHART_TONE_TEXT[tone])} /> : null}
          <span className="truncate">{label}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="truncate text-xl font-semibold">{displayValue}</span>
          {delta ? (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                CHART_TONE_TEXT[deltaTone],
              )}
            >
              <DeltaIcon className="size-3" />
              {formatCompactValue(Math.abs(delta.value))}%
            </span>
          ) : null}
        </div>
      </div>
      {sparkPoints ? (
        <svg
          width={SPARK_W}
          height={SPARK_H}
          viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
          aria-hidden="true"
          className="shrink-0"
        >
          <path
            d={buildLinePath(sparkPoints)}
            className={CHART_TONE_STROKE[tone]}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      ) : null}
    </div>
  );
}

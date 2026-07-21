import { cn } from "~/lib/utils";

import { type ChartTone, CHART_TONE_BG } from "./chartTheme";
import { formatCompactValue } from "./scale.logic";

export interface MeterProps {
  readonly value: number;
  readonly label: string;
  readonly warnAt?: number;
  readonly dangerAt?: number;
}

function toneFor(value: number, warnAt?: number, dangerAt?: number): ChartTone {
  if (dangerAt !== undefined && value >= dangerAt) return "danger";
  if (warnAt !== undefined && value >= warnAt) return "warning";
  return "default";
}

/** Horizontal 0-100% capacity meter. The value is always shown as text — never color alone. */
export function Meter({ value, label, warnAt, dangerAt }: MeterProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const tone = toneFor(clamped, warnAt, dangerAt);

  return (
    <div role="img" aria-label={`${label}: ${formatCompactValue(clamped, "%")}`} className="w-full">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="font-mono tabular-nums text-foreground">
          {formatCompactValue(clamped, "%")}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn("h-full rounded-full transition-[width]", CHART_TONE_BG[tone])}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

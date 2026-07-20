/** Pure chart math: scales, ticks, time labels, path builders. No DOM, no React. */

export interface PathPoint {
  readonly x: number;
  readonly y: number;
}

/** Linear scale: maps a domain value to a range value. Swap args to invert. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value: number): number => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
}

function niceStep(rawStep: number): number {
  const exponent = Math.floor(Math.log10(rawStep));
  const fraction = rawStep / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
}

/** ~3-5 "nice" ticks spanning [min, max] (inclusive), e.g. 0/25/50/75/100. */
export function niceTicks(min: number, max: number, targetCount = 4): number[] {
  if (min === max) return [min];
  const step = niceStep((max - min) / Math.max(1, targetCount - 1));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) {
    ticks.push(Math.round(v / step) * step); // clean floating-point noise
  }
  return ticks;
}

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** HH:mm, local time. Manual formatting (not Intl) so output is locale-independent. */
export function formatClock(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** dd MMM, local time, e.g. "20 Jul". */
export function formatDayMonth(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getDate())} ${MONTH_ABBR[d.getMonth()]}`;
}

const ONE_DAY_MS = 86_400_000;

/** Picks HH:mm for a same-day-ish span, dd MMM once the axis spans more than a day. */
export function formatAxisTime(t: number, spanMs: number): string {
  return spanMs > ONE_DAY_MS ? formatDayMonth(t) : formatClock(t);
}

/** Compact number formatting shared by every chart label/tooltip (no Intl — deterministic). */
export function formatCompactValue(value: number, unit?: string): string {
  const abs = Math.abs(value);
  const compact =
    abs >= 1000
      ? `${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`
      : Number.isInteger(value)
        ? String(value)
        : value.toFixed(abs < 10 ? 2 : 1);
  return unit ? `${compact}${unit}` : compact;
}

export function buildLinePath(points: readonly PathPoint[]): string {
  if (!points.length) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

/** Line path closed down to `baselineY`, for a filled area under a line. */
export function buildAreaPath(points: readonly PathPoint[], baselineY: number): string {
  if (!points.length) return "";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${buildLinePath(points)} L${last.x},${baselineY} L${first.x},${baselineY} Z`;
}

export interface StackSegment {
  readonly key: string;
  readonly value: number;
  readonly start: number;
  readonly end: number;
}

/** Cumulative offsets for a stacked bar, in input order (first = bottom, touches baseline). */
export function stackValues(values: readonly { key: string; value: number }[]): StackSegment[] {
  let cursor = 0;
  return values.map(({ key, value }) => {
    const start = cursor;
    cursor += value;
    return { key, value, start, end: cursor };
  });
}

/**
 * A vertical bar segment path: rounded top corners (the data-end), square
 * bottom (anchored to the baseline/next segment). Used for both a plain bar
 * (one segment) and a stack's topmost segment; interior stack segments should
 * use a plain rect instead — they aren't a data-end.
 */
export function roundedTopBarPath(
  x: number,
  width: number,
  yTop: number,
  yBottom: number,
  radius = 4,
): string {
  const r = Math.max(0, Math.min(radius, width / 2, yBottom - yTop));
  if (r <= 0) return `M${x},${yTop} H${x + width} V${yBottom} H${x} Z`;
  return [
    `M${x},${yBottom}`,
    `V${yTop + r}`,
    `Q${x},${yTop} ${x + r},${yTop}`,
    `H${x + width - r}`,
    `Q${x + width},${yTop} ${x + width},${yTop + r}`,
    `V${yBottom}`,
    "Z",
  ].join(" ");
}

/** Index of the point whose `t` is nearest to `target` (linear scan — data volumes are small). */
export function nearestIndexByT(points: readonly { t: number }[], target: number): number {
  let bestIndex = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    const delta = Math.abs(points[i]!.t - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestIndex;
}

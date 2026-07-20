/**
 * Validated chart palette for the GITS Cockpit charts.
 *
 * Method: dataviz skill (form -> color -> validate). Categorical order is the
 * skill's documented default, first 4 slots (blue/green/magenta/yellow) —
 * this app only ever needs <=4 series per chart, and those 4 slots are the
 * ones that clear the *all-pairs* CVD gate (5th+ slot only clears the weaker
 * adjacent-pairs gate, see references/palette.md), so capping at 4 here is
 * the right ceiling, not a shortcut.
 *
 * Re-validated against THIS app's actual card surfaces (light `--card`
 * #ffffff, dark `--card` ~#1b1b1b — computed from src/index.css:
 * `color-mix(in srgb, color-mix(in srgb, neutral-950 95%, white) 98%, white)`)
 * rather than the skill's generic #fcfcfb/#1a1a19 reference surfaces:
 *
 *   node scripts/validate_palette.js "#2a78d6,#008300,#e87ba4,#eda100" \
 *     --mode light --surface "#ffffff" [--pairs all]
 *   node scripts/validate_palette.js "#3987e5,#008300,#d55181,#c98500" \
 *     --mode dark --surface "#1b1b1b" [--pairs all]
 *
 * Results (adjacent AND all-pairs, both modes — ALL CHECKS PASS):
 *   light adjacent : CVD 16.3 (deutan) · normal-vision 19.6 · contrast WARN
 *                    on magenta/yellow (2.69/2.17, below 3:1)
 *   light all-pairs: CVD 13.0 (protan) · normal-vision 19.6 · same contrast WARN
 *   dark adjacent  : CVD 13.0 (deutan) · normal-vision 19.3 · contrast PASS (all >=3:1)
 *   dark all-pairs : CVD 6.9 (protan, floor band, WARN) · normal-vision 19.3 · contrast PASS
 *
 * The two WARNs are exactly the documented-palette ones (see references/palette.md)
 * and both are covered by secondary encoding already shipped by these
 * components: legend + per-series tooltip values (never color alone), so
 * series identity/value is always readable without the color channel.
 */

export interface ChartSeriesColor {
  readonly id: string;
  readonly label: string;
  readonly light: string;
  readonly dark: string;
}

/** Categorical series slots, in fixed order — never cycle past index 3. */
export const CHART_SERIES: readonly ChartSeriesColor[] = [
  { id: "series-1", label: "blue", light: "#2a78d6", dark: "#3987e5" },
  { id: "series-2", label: "green", light: "#008300", dark: "#008300" },
  { id: "series-3", label: "magenta", light: "#e87ba4", dark: "#d55181" },
  { id: "series-4", label: "yellow", light: "#eda100", dark: "#c98500" },
];
// ponytail: 4 slots — task caps series at 4. Add slots 5-8 from the skill's
// documented order (aqua/orange/violet/red) only if a chart ever needs more,
// and re-validate with --pairs all before shipping (5-8 fail all-pairs CVD).

/** Sequential magnitude ramp: one hue (blue). Base step doubles as series-1. */
export const CHART_SEQUENTIAL = { light: "#2a78d6", dark: "#3987e5" };

/** The chart surfaces the palette above was validated against (`--card`). */
export const CHART_SURFACE = { light: "#ffffff", dark: "#1b1b1b" };

export type ChartTone = "default" | "success" | "warning" | "danger";

/**
 * Status tone -> Tailwind utility class, reusing the cockpit's existing
 * --success/--warning/--destructive tokens (src/index.css) — already
 * WCAG-vetted app-wide, so status colors are not re-validated by the
 * categorical palette script (out of its scope; see color-formula.md § Scope).
 */
export const CHART_TONE_STROKE: Record<ChartTone, string> = {
  default: "stroke-muted-foreground",
  success: "stroke-success",
  warning: "stroke-warning",
  danger: "stroke-destructive",
};

export const CHART_TONE_FILL: Record<ChartTone, string> = {
  default: "fill-muted-foreground",
  success: "fill-success",
  warning: "fill-warning",
  danger: "fill-destructive",
};

export const CHART_TONE_TEXT: Record<ChartTone, string> = {
  default: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

export const CHART_TONE_BG: Record<ChartTone, string> = {
  default: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** CSS custom property name for a categorical slot; use on `stroke`/`fill` attributes. */
export function seriesVar(index: number): string {
  const slot = CHART_SERIES[index % CHART_SERIES.length]!;
  return `var(--gits-chart-${slot.id})`;
}

/**
 * Spread onto a chart's root element `style`: defines every series slot's
 * custom property once, resolved per-mode by the native CSS `light-dark()`
 * function. This app already sets `color-scheme` from the `.dark` class (see
 * src/index.css), which is exactly what `light-dark()` reads — so this needs
 * no Tailwind class at all (a dynamic `[--x:${value}]` arbitrary-property
 * class can't work here: Tailwind's scanner only picks up literal strings
 * that appear verbatim in source, not runtime template output).
 */
export const CHART_SERIES_STYLE: Record<string, string> = Object.fromEntries(
  CHART_SERIES.map((s) => [`--gits-chart-${s.id}`, `light-dark(${s.light}, ${s.dark})`]),
);

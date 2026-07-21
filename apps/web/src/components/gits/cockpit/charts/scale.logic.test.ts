import { describe, expect, it } from "vitest";

import {
  buildAreaPath,
  buildLinePath,
  formatAxisTime,
  formatClock,
  formatCompactValue,
  formatDayMonth,
  linearScale,
  nearestIndexByT,
  niceTicks,
  roundedTopBarPath,
  stackValues,
} from "./scale.logic";

describe("linearScale", () => {
  it("maps domain to range", () => {
    const scale = linearScale([0, 100], [0, 200]);
    expect(scale(0)).toBe(0);
    expect(scale(50)).toBe(100);
    expect(scale(100)).toBe(200);
  });

  it("inverts by swapping domain and range", () => {
    const scale = linearScale([0, 100], [10, 60]);
    const invert = linearScale([10, 60], [0, 100]);
    expect(invert(scale(37))).toBeCloseTo(37);
  });

  it("returns the range start for a degenerate (zero-width) domain", () => {
    const scale = linearScale([5, 5], [0, 100]);
    expect(scale(5)).toBe(0);
  });
});

describe("niceTicks", () => {
  it("produces clean bounds for 0-100", () => {
    const ticks = niceTicks(0, 100, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(100);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(6);
  });

  it("handles a single-value domain", () => {
    expect(niceTicks(7, 7)).toEqual([7]);
  });

  it("handles small fractional domains", () => {
    const ticks = niceTicks(0, 1.4, 4);
    expect(ticks[0]).toBeLessThanOrEqual(0);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(1.4);
  });
});

describe("time formatting", () => {
  it("formats HH:mm", () => {
    const t = new Date(2026, 6, 20, 9, 5).getTime();
    expect(formatClock(t)).toBe("09:05");
  });

  it("formats dd MMM", () => {
    const t = new Date(2026, 6, 20, 9, 5).getTime();
    expect(formatDayMonth(t)).toBe("20 Jul");
  });

  it("picks HH:mm under a one-day span and dd MMM over it", () => {
    const t = new Date(2026, 6, 20, 9, 5).getTime();
    expect(formatAxisTime(t, 60 * 60 * 1000)).toBe(formatClock(t));
    expect(formatAxisTime(t, 3 * 86_400_000)).toBe(formatDayMonth(t));
  });
});

describe("formatCompactValue", () => {
  it("passes small integers through", () => {
    expect(formatCompactValue(42)).toBe("42");
  });

  it("compacts thousands with a k suffix", () => {
    expect(formatCompactValue(12_400)).toBe("12k");
    expect(formatCompactValue(1_200)).toBe("1.2k");
  });

  it("appends the unit when given", () => {
    expect(formatCompactValue(87, "%")).toBe("87%");
  });
});

describe("path builders", () => {
  it("builds a line path", () => {
    expect(
      buildLinePath([
        { x: 0, y: 10 },
        { x: 5, y: 2 },
      ]),
    ).toBe("M0,10 L5,2");
  });

  it("returns an empty string for no points", () => {
    expect(buildLinePath([])).toBe("");
    expect(buildAreaPath([], 10)).toBe("");
  });

  it("builds a closed area path anchored to the baseline", () => {
    const path = buildAreaPath(
      [
        { x: 0, y: 10 },
        { x: 5, y: 2 },
      ],
      20,
    );
    expect(path).toBe("M0,10 L5,2 L5,20 L0,20 Z");
  });
});

describe("stackValues", () => {
  it("accumulates start/end offsets from the baseline", () => {
    const segments = stackValues([
      { key: "a", value: 10 },
      { key: "b", value: 5 },
    ]);
    expect(segments).toEqual([
      { key: "a", value: 10, start: 0, end: 10 },
      { key: "b", value: 5, start: 10, end: 15 },
    ]);
  });

  it("a single value behaves like a plain (unstacked) bar", () => {
    expect(stackValues([{ key: "only", value: 7 }])).toEqual([
      { key: "only", value: 7, start: 0, end: 7 },
    ]);
  });
});

describe("roundedTopBarPath", () => {
  it("rounds the top corners and stays square at the baseline", () => {
    const path = roundedTopBarPath(0, 20, 0, 100, 4);
    expect(path.startsWith("M0,100")).toBe(true);
    expect(path).toContain("Q0,0 4,0");
    expect(path).toContain("Q20,0 20,4");
  });

  it("clamps the radius for a bar shorter than the requested radius", () => {
    const path = roundedTopBarPath(0, 20, 98, 100, 4);
    expect(path).not.toContain("NaN");
  });

  it("falls back to a plain rect path at zero radius", () => {
    expect(roundedTopBarPath(0, 10, 0, 50, 0)).toBe("M0,0 H10 V50 H0 Z");
  });
});

describe("nearestIndexByT", () => {
  it("finds the closest point by t", () => {
    const points = [{ t: 0 }, { t: 10 }, { t: 20 }];
    expect(nearestIndexByT(points, 8)).toBe(1);
    expect(nearestIndexByT(points, 21)).toBe(2);
    expect(nearestIndexByT(points, -5)).toBe(0);
  });
});

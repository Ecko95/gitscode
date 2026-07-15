import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  clampUsagePercent,
  selectProviderUsageWindows,
  usageProviderForDriver,
} from "./providerUsage";

const usageWindow = (provider: "codex" | "claude", windowMinutes: number, usedPercent: number) => ({
  provider,
  label: "usage",
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowMinutes,
  resetAt: null,
  sourcePath: null,
});
const summary = {
  windows: [
    usageWindow("codex", 300, 25),
    usageWindow("codex", 10080, 60),
    usageWindow("claude", 300, 80),
  ],
};

describe("provider usage", () => {
  it("maps supported chat drivers to usage providers", () => {
    expect(usageProviderForDriver(ProviderDriverKind.make("codex"))).toBe("codex");
    expect(usageProviderForDriver(ProviderDriverKind.make("claudeAgent"))).toBe("claude");
    expect(usageProviderForDriver(ProviderDriverKind.make("cursor"))).toBeNull();
  });

  it("selects only the requested provider's 5h and weekly windows", () => {
    expect(selectProviderUsageWindows(summary, "codex")).toEqual({
      fiveHour: summary.windows[0],
      weekly: summary.windows[1],
    });
    expect(selectProviderUsageWindows(summary, "claude")).toEqual({
      fiveHour: summary.windows[2],
      weekly: null,
    });
  });

  it("clamps progress values to the native progress range", () => {
    expect(clampUsagePercent(-1)).toBe(0);
    expect(clampUsagePercent(42.5)).toBe(42.5);
    expect(clampUsagePercent(101)).toBe(100);
  });
});

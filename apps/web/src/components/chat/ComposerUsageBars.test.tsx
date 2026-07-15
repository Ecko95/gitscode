import type { UsageWindowSummary } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerUsageBars } from "./ComposerUsageBars";

const window = (usedPercent: number, resetAt: string): UsageWindowSummary => ({
  provider: "codex",
  label: "usage",
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowMinutes: 300,
  resetAt,
  sourcePath: null,
});

describe("ComposerUsageBars", () => {
  it("renders accessible 5h and weekly progress", () => {
    const markup = renderToStaticMarkup(
      <ComposerUsageBars
        provider="codex"
        windows={{
          fiveHour: window(25.4, "2026-07-15T18:00:00.000Z"),
          weekly: { ...window(61, "2026-07-20T18:00:00.000Z"), windowMinutes: 10080 },
        }}
      />,
    );

    expect(markup).toContain('aria-label="Codex 5h usage"');
    expect(markup).toContain('aria-label="Codex weekly usage"');
    expect(markup).toContain("25%");
    expect(markup).toContain("61%");
    expect(markup).toContain("Resets");
  });

  it("keeps missing windows visible as unavailable", () => {
    const markup = renderToStaticMarkup(
      <ComposerUsageBars provider="claude" windows={{ fiveHour: null, weekly: null }} />,
    );

    expect(markup.match(/Usage unavailable/g)).toHaveLength(2);
  });
});

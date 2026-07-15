import "../../index.css";

import type { UsageWindowSummary } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerUsageBars } from "./ComposerUsageBars";

const usageWindow: UsageWindowSummary = {
  provider: "codex",
  label: "usage",
  usedPercent: 25,
  remainingPercent: 75,
  windowMinutes: 300,
  resetAt: null,
  sourcePath: null,
};

describe("ComposerUsageBars", () => {
  beforeEach(() => localStorage.clear());

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("centers usage and keeps a discoverable collapsed strip", async () => {
    const screen = await render(
      <ComposerUsageBars
        provider="codex"
        windows={{ fiveHour: usageWindow, weekly: usageWindow }}
      />,
    );

    try {
      await vi.waitFor(() => expect(document.querySelector("progress")).toBeTruthy());
      const progress = document.querySelector("progress");
      const row = progress?.parentElement;
      expect(progress).toBeTruthy();
      expect(row).toBeTruthy();
      const progressBox = progress?.getBoundingClientRect();
      const rowBox = row?.getBoundingClientRect();
      expect(
        Math.abs(
          (progressBox?.x ?? 0) +
            (progressBox?.width ?? 0) / 2 -
            ((rowBox?.x ?? 0) + (rowBox?.width ?? 0) / 2),
        ),
      ).toBeLessThan(1);

      document.querySelector<HTMLButtonElement>('[aria-label="Collapse usage"]')?.click();

      await expect.element(screen.getByText("Usage", { exact: true })).toBeVisible();
      await expect.element(screen.getByRole("button", { name: "Expand usage" })).toBeVisible();
      expect(document.querySelector("progress")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

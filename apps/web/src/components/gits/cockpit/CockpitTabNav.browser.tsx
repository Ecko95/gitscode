import "../../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CockpitTabNav } from "./CockpitTabNav";
import { GITS_COCKPIT_TABS, type GitsCockpitTab } from "./tabs";

const COUNTS: Record<GitsCockpitTab, string> = {
  overview: "—",
  motoko: "2",
  autopilot: "1",
  fleet: "3",
  system: "ok",
};

/** Controlled harness matching how `GitsCockpit.tsx` actually drives the nav — lets clicks
 *  and arrow-key nav be asserted against real `aria-selected`/`tabIndex` updates, not just
 *  the `onTabChange` callback. */
function ControlledNav({ onTabChange }: { onTabChange?: (tab: GitsCockpitTab) => void }) {
  const [activeTab, setActiveTab] = useState<GitsCockpitTab>("overview");
  return (
    <CockpitTabNav
      activeTab={activeTab}
      counts={COUNTS}
      onTabChange={(tab) => {
        setActiveTab(tab);
        onTabChange?.(tab);
      }}
    />
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("CockpitTabNav", () => {
  it("renders all 5 tabs with the command tab selected by default", async () => {
    const screen = await render(<ControlledNav />);
    try {
      for (const tab of GITS_COCKPIT_TABS) {
        await expect
          .element(page.getByRole("tab", { name: new RegExp(tab.label) }))
          .toBeInTheDocument();
      }
      await expect
        .element(page.getByRole("tab", { name: /Command/ }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("tab", { name: /Motoko/ }))
        .toHaveAttribute("aria-selected", "false");
    } finally {
      await screen.unmount();
    }
  });

  it("click switches the selected tab", async () => {
    const onTabChange = vi.fn();
    const screen = await render(<ControlledNav onTabChange={onTabChange} />);
    try {
      await page.getByRole("tab", { name: /Fleet/ }).click();
      expect(onTabChange).toHaveBeenCalledWith("fleet");
      await expect
        .element(page.getByRole("tab", { name: /Fleet/ }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(page.getByRole("tab", { name: /Command/ }))
        .toHaveAttribute("aria-selected", "false");
    } finally {
      await screen.unmount();
    }
  });

  it("ArrowRight moves both focus and selection to the next tab", async () => {
    const screen = await render(<ControlledNav />);
    try {
      await page.getByRole("tab", { name: /Command/ }).click();
      await userEvent.keyboard("{ArrowRight}");
      const motokoTab = page.getByRole("tab", { name: /Motoko/ });
      await expect.element(motokoTab).toHaveFocus();
      await expect.element(motokoTab).toHaveAttribute("aria-selected", "true");
      await expect.element(motokoTab).toHaveAttribute("tabindex", "0");
      await expect
        .element(page.getByRole("tab", { name: /Command/ }))
        .toHaveAttribute("tabindex", "-1");
    } finally {
      await screen.unmount();
    }
  });

  it("ArrowLeft from the first tab wraps around to the last tab", async () => {
    const screen = await render(<ControlledNav />);
    try {
      await page.getByRole("tab", { name: /Command/ }).click();
      await userEvent.keyboard("{ArrowLeft}");
      const systemTab = page.getByRole("tab", { name: /System/ });
      await expect.element(systemTab).toHaveFocus();
      await expect.element(systemTab).toHaveAttribute("aria-selected", "true");
    } finally {
      await screen.unmount();
    }
  });
});

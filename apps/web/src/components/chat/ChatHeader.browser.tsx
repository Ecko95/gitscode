import "../../index.css";

import { EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const ACTIVE_THREAD_ID = "thread-child" as ThreadId;
const FORK_THREAD_ID = "thread-fork" as ThreadId;

function buildProps() {
  return {
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    activeThreadId: ACTIVE_THREAD_ID,
    activeThreadTitle: "Child thread",
    activeProjectName: undefined,
    forkedFromThread: {
      title: "Source thread",
      onOpen: vi.fn(),
    },
    forkedThreads: [{ id: FORK_THREAD_ID, title: "Forked child thread" }],
    onOpenForkedThread: vi.fn(),
    isGitRepo: false,
    openInCwd: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    availableEditors: [],
    terminalAvailable: false,
    terminalOpen: false,
    terminalToggleShortcutLabel: null,
    diffToggleShortcutLabel: null,
    gitCwd: null,
    diffOpen: false,
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(),
    onUpdateProjectScript: vi.fn(),
    onDeleteProjectScript: vi.fn(),
    onToggleTerminal: vi.fn(),
    onToggleDiff: vi.fn(),
  };
}

describe("ChatHeader fork affordances", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the source thread from the forked-from chip", async () => {
    const props = buildProps();
    const screen = await render(
      <SidebarProvider>
        <ChatHeader {...props} />
      </SidebarProvider>,
    );

    try {
      const chip = document.querySelector<HTMLButtonElement>('[data-testid="forked-from-chip"]');
      expect(chip).toBeTruthy();
      expect(chip?.textContent).toContain("Forked from");
      expect(chip?.textContent).toContain("Source thread");

      chip?.click();
      expect(props.forkedFromThread.onOpen).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("opens child forks from the forks menu", async () => {
    const props = buildProps();
    const screen = await render(
      <SidebarProvider>
        <ChatHeader {...props} />
      </SidebarProvider>,
    );

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-testid="thread-forks-menu-trigger"]',
      );
      expect(trigger).toBeTruthy();
      expect(trigger?.textContent).toContain("1 fork");

      trigger?.click();

      await vi.waitFor(
        () => {
          const childItem =
            Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')).find(
              (item) => item.textContent?.includes("Forked child thread"),
            ) ?? null;
          expect(childItem).toBeTruthy();
          childItem?.click();
        },
        { timeout: 4_000, interval: 16 },
      );

      expect(props.onOpenForkedThread).toHaveBeenCalledWith(FORK_THREAD_ID);
    } finally {
      await screen.unmount();
    }
  });
});

import "../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SubagentTask } from "../session-logic";
import { SubagentTaskCard, SubagentTaskTabs, SubagentTaskTranscript } from "./SubagentTaskSurface";

const task: SubagentTask = {
  id: "agent-browser-1",
  title: "Inspect reconnect behavior",
  description: "Inspect reconnect behavior and report any races.",
  status: "running",
  startedAt: "2026-02-23T00:00:01.000Z",
  turnId: null,
  logs: [
    {
      id: "agent-browser-log-1",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "tool.started",
      label: "Ran command started",
      detail: "bun run test",
      tone: "tool",
    },
  ],
};

describe("SubagentTaskSurface", () => {
  it("opens a task from an accessible sidebar card", async () => {
    const onOpen = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<SubagentTaskCard task={task} onOpen={onOpen} />, {
      container: host,
    });
    try {
      await page
        .getByRole("button", { name: "Open agent task Inspect reconnect behavior" })
        .click();
      expect(onOpen).toHaveBeenCalledWith("agent-browser-1");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps Main permanent while task tabs can be selected and closed", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <SubagentTaskTabs tasks={[task]} activeTaskId={null} onSelect={onSelect} onClose={onClose} />,
      { container: host },
    );
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Main"));
      expect(page.getByRole("tab", { name: "Main" })).toBeInTheDocument();
      await page.getByRole("tab", { name: "Inspect reconnect behavior" }).click();
      expect(onSelect).toHaveBeenCalledWith("agent-browser-1");

      await page.getByRole("button", { name: "Close Inspect reconnect behavior tab" }).click();
      expect(onClose).toHaveBeenCalledWith("agent-browser-1");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows live task status, prompt, and concrete activity logs", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<SubagentTaskTranscript task={task} />, { container: host });
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Inspect reconnect behavior"));
      expect(page.getByRole("heading", { name: "Inspect reconnect behavior" })).toBeInTheDocument();
      expect(page.getByText("Running")).toBeInTheDocument();
      expect(
        page.getByText("Inspect reconnect behavior and report any races."),
      ).toBeInTheDocument();
      expect(page.getByText("Ran command started")).toBeInTheDocument();
      expect(page.getByText("bun run test")).toBeInTheDocument();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

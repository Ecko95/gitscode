import "../../../index.css";

import type { AutomodeSnapshot, HermesProposalListResult } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const ENVIRONMENT_ID = "autopilot-environment" as never;
const automode = vi.hoisted(() => ({ configure: vi.fn(), stopAll: vi.fn() }));
const cockpitInbox = vi.hoisted(() => ({
  list: vi.fn(),
  markAllRead: vi.fn(),
  markRead: vi.fn(),
  pin: vi.fn(),
}));

vi.mock("~/environments/primary", async (importOriginal) => ({
  ...(await importOriginal()),
  usePrimaryEnvironmentId: () => ENVIRONMENT_ID,
}));
vi.mock("~/gitsClient", () => ({
  readGitsEnvironmentClient: () => ({ automode, cockpitInbox }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { AutopilotPanel } from "./AutopilotPanel";
import { TEST_PROPOSAL } from "./proposal-launch/proposalLaunch.logic";

const snapshot = (on: boolean, repositories = ["/srv/project"]): AutomodeSnapshot =>
  ({
    policy: {
      mode: on ? "autonomous" : "manual",
      killSwitchEnabled: !on,
      proposalRepos: repositories,
      allowedRepos: repositories,
      allowedModels: ["gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      maxRuntimeMinutes: 60,
      verificationCommands: [],
      integrationBranch: null,
    },
    goals: [
      {
        id: "goal-1",
        title: "Ship the simple flow",
        repo: "/srv/project",
        status: "queued",
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    ],
    activePeerCount: 0,
    pendingApprovalCount: 0,
  }) as unknown as AutomodeSnapshot;

function panel(
  value: AutomodeSnapshot,
  focusedProposalId: string | null = null,
  proposals: HermesProposalListResult | undefined = undefined,
) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <AutopilotPanel
        error={null}
        focusedProposalId={focusedProposalId}
        loading={false}
        onProposalDecision={vi.fn()}
        onRefresh={vi.fn()}
        projects={[]}
        proposals={proposals}
        snapshot={value}
      />
    </QueryClientProvider>
  );
}

function renderPanel(value: AutomodeSnapshot) {
  return render(panel(value));
}

beforeEach(() => {
  automode.configure.mockResolvedValue(undefined);
  automode.stopAll.mockResolvedValue({ stoppedPeers: 0, failures: 0 });
  cockpitInbox.list.mockResolvedValue({
    items: [],
    counts: { unread: 0, active: 0, "needs-attention": 0, all: 0 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("AutopilotPanel", () => {
  it("shows only the simple operator controls", async () => {
    renderPanel(snapshot(false));
    await expect.element(page.getByText("Paused", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Watched repositories")).toBeVisible();
    await expect.element(page.getByText("Inbox", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Queue", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Emergency Stop" })).toBeVisible();
    expect(document.body.textContent).not.toContain("Automation switchboard");
    expect(document.body.textContent).not.toContain("Max budget");
    expect(document.body.textContent).not.toContain("Scheduler arm");
    expect(document.body.textContent).not.toContain("Manual goal");
  });

  it("pauses through the narrow configure operation", async () => {
    renderPanel(snapshot(true));
    await page.getByRole("button", { name: "Pause" }).click();
    expect(automode.configure).toHaveBeenCalledWith({
      enabled: false,
      repositories: ["/srv/project"],
    });
  });

  it("refuses to enable without a watched repository", async () => {
    renderPanel(snapshot(false, []));
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Choose at least one");
    expect(automode.configure).not.toHaveBeenCalled();
  });

  it("does not reopen a consumed deep-linked proposal after polling", async () => {
    const proposals = {
      proposals: [TEST_PROPOSAL],
      checkedAt: "2026-08-09T00:00:00.000Z",
    } satisfies HermesProposalListResult;
    const screen = await render(panel(snapshot(false), TEST_PROPOSAL.id, proposals));
    await expect.element(page.getByText("Validate and queue")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect.element(page.getByText("Validate and queue")).not.toBeInTheDocument();

    await screen.rerender(
      panel(snapshot(false), TEST_PROPOSAL.id, {
        ...proposals,
        checkedAt: "2026-08-09T00:01:00.000Z",
      }),
    );
    await expect.element(page.getByText("Validate and queue")).not.toBeInTheDocument();
  });
});

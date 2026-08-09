import "../../../index.css";

import type { AutomodeGoal, AutomodePolicy } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProposalLaunchSheet } from "./ProposalLaunchSheet";
import { TEST_PROPOSAL } from "./proposal-launch/proposalLaunch.logic";

const policy = {
  allowedRepos: ["/srv/example-project"],
  proposalRepos: ["/srv/example-project"],
  allowedModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
  defaultModel: "gpt-5.6-terra",
  maxRuntimeMinutes: 60,
  verificationCommands: [],
  integrationBranch: null,
} as unknown as AutomodePolicy;

const queuedGoal = {
  id: "goal-1",
  episodeId: TEST_PROPOSAL.episodeId,
  title: TEST_PROPOSAL.title,
  prompt: TEST_PROPOSAL.nextCommandOrPrompt!,
  repo: TEST_PROPOSAL.projectDir!,
  model: TEST_PROPOSAL.model,
  status: "queued",
  peerId: null,
  blockedReason: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  approvedAt: "2026-08-09T00:00:00.000Z",
  rejectedAt: null,
  workflowId: null,
  origin: "proposal",
  branch: null,
  notBefore: null,
  maxRuntimeMinutes: 45,
  verificationCommands: [],
  integrationBranch: null,
  planningNotes: null,
  planningBoundary: null,
} satisfies AutomodeGoal;

describe("ProposalLaunchSheet", () => {
  it("guides review, model choice, advanced details, and queue confirmation", async () => {
    const onDecision = vi.fn().mockResolvedValue(queuedGoal);
    render(
      <ProposalLaunchSheet
        onDecision={onDecision}
        onOpenChange={() => undefined}
        open
        policy={policy}
        proposal={TEST_PROPOSAL}
      />,
    );

    await expect.element(page.getByText("1 of 3")).toBeVisible();
    await expect.element(page.getByText(TEST_PROPOSAL.summary)).toBeVisible();
    await expect.element(page.getByText("Notification delivery")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect.element(page.getByText("2 of 3")).toBeVisible();
    await expect.element(page.getByRole("combobox", { name: "Model" })).toBeVisible();
    await expect.element(page.getByText("Terra · Balanced")).toBeVisible();
    await expect.element(page.getByText("Repository override")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Advanced details" }).click();
    await expect.element(page.getByText("Repository override")).toBeVisible();
    await page.getByRole("button", { name: "Review queue" }).click();

    await expect.element(page.getByText("3 of 3")).toBeVisible();
    await expect.element(page.getByText("/srv/example-project")).toBeVisible();
    await page.getByRole("button", { name: "Accept & Queue" }).click();
    expect(onDecision).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText("Queued", { exact: true })).toBeVisible();
    await expect.element(page.getByText(queuedGoal.title)).toBeVisible();
  });

  it("keeps Later on the existing decision callback", async () => {
    const onDecision = vi.fn().mockResolvedValue(null);
    render(
      <ProposalLaunchSheet
        onDecision={onDecision}
        onOpenChange={() => undefined}
        open
        policy={policy}
        proposal={TEST_PROPOSAL}
      />,
    );
    await page.getByRole("button", { name: "Later" }).click();
    expect(onDecision).toHaveBeenCalledWith(TEST_PROPOSAL, "defer", expect.any(Object));
  });

  it("keeps Reject on the existing decision callback", async () => {
    const onDecision = vi.fn().mockResolvedValue(null);
    render(
      <ProposalLaunchSheet
        onDecision={onDecision}
        onOpenChange={() => undefined}
        open
        policy={policy}
        proposal={TEST_PROPOSAL}
      />,
    );
    await page.getByRole("button", { name: "Reject" }).click();
    expect(onDecision).toHaveBeenCalledWith(TEST_PROPOSAL, "reject", expect.any(Object));
  });

  it("completes proposal notification test mode without a decision", async () => {
    const onDecision = vi.fn();
    render(
      <ProposalLaunchSheet
        onDecision={onDecision}
        onOpenChange={() => undefined}
        open
        policy={policy}
        proposal={null}
        testMode="proposal"
      />,
    );
    await expect.element(page.getByText("Test notification")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Review queue" }).click();
    await page.getByRole("button", { name: "Complete Test" }).click();
    expect(onDecision).not.toHaveBeenCalled();
    await expect.element(page.getByText("Test complete")).toBeVisible();
  });
});

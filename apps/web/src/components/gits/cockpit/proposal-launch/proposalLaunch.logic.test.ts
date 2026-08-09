import {
  CODEX_MODEL_TIERS,
  type AutomodePolicy,
  type HermesProposalCard,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  TEST_PROPOSAL,
  initialProposalLaunchForm,
  launchModelOptions,
  proposalLaunchEdits,
  validateProposalLaunchForm,
} from "./proposalLaunch.logic.ts";

const policy = {
  allowedRepos: ["/srv/repo"],
  allowedModels: ["model-a", "model-b"],
  defaultModel: "model-b",
  maxRuntimeMinutes: 60,
  verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
  integrationBranch: "autopilot/main",
} as unknown as AutomodePolicy;

const proposal = {
  ...TEST_PROPOSAL,
  projectDir: "/srv/repo",
  model: "model-a",
  notBefore: "2026-08-10T20:30:00.000Z",
  maxRuntimeMinutes: 45,
  verificationCommands: [{ label: "lint", cmd: ["bun", "lint"] }],
  integrationBranch: "autopilot/proposal",
} satisfies HermesProposalCard;

describe("guided proposal launch logic", () => {
  it("uses proposal choices before policy defaults", () => {
    expect(initialProposalLaunchForm(proposal, policy)).toMatchObject({
      repository: "/srv/repo",
      model: "model-a",
      notBefore: "2026-08-10T20:30",
      runtime: "45",
      integrationBranch: "autopilot/proposal",
      verificationCommands: [{ label: "lint", cmd: ["bun", "lint"] }],
    });

    expect(
      initialProposalLaunchForm({ ...proposal, model: null, maxRuntimeMinutes: null }, policy),
    ).toMatchObject({ model: "model-b", runtime: "60" });
  });

  it("uses allowed models or the three built-in tiers without duplicates", () => {
    expect(launchModelOptions(policy).map((item) => item.value)).toEqual(["model-a", "model-b"]);
    expect(launchModelOptions({ ...policy, allowedModels: [] }).map((item) => item.value)).toEqual([
      CODEX_MODEL_TIERS.light,
      CODEX_MODEL_TIERS.medium,
      CODEX_MODEL_TIERS.high,
    ]);
  });

  it("validates repository, model, runtime, and start time", () => {
    const form = initialProposalLaunchForm(proposal, policy);
    expect(validateProposalLaunchForm(form)).toEqual({ ok: true });
    expect(validateProposalLaunchForm({ ...form, repository: "" })).toMatchObject({
      ok: false,
      field: "repository",
    });
    expect(validateProposalLaunchForm({ ...form, model: "" })).toMatchObject({
      ok: false,
      field: "model",
    });
    expect(validateProposalLaunchForm({ ...form, runtime: "-1" })).toMatchObject({
      ok: false,
      field: "runtime",
    });
    expect(validateProposalLaunchForm({ ...form, notBefore: "invalid" })).toMatchObject({
      ok: false,
      field: "notBefore",
    });
  });

  it("builds typed edits and converts local time to ISO", () => {
    const form = initialProposalLaunchForm(proposal, policy);
    expect(proposalLaunchEdits(form)).toEqual({
      title: proposal.title,
      prompt: proposal.nextCommandOrPrompt,
      projectDir: "/srv/repo",
      model: "model-a",
      notBefore: new Date("2026-08-10T20:30").toISOString(),
      maxRuntimeMinutes: 45,
      verificationCommands: [{ label: "lint", cmd: ["bun", "lint"] }],
      integrationBranch: "autopilot/proposal",
    });
  });

  it("exports a deterministic proposal-only test fixture", () => {
    expect(TEST_PROPOSAL).toMatchObject({
      id: "notification-test-proposal",
      episodeId: "notification-test-episode",
      status: "proposed",
      projectDir: "/srv/example-project",
    });
  });
});

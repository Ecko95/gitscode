import {
  CODEX_MODEL_TIERS,
  type AutomodePolicy,
  type GitsVerifyCommand,
  type HermesProposalCard,
  type HermesProposalDecisionInput,
} from "@t3tools/contracts";

export type LaunchStep = "idea" | "model" | "review";

export interface ProposalLaunchForm {
  readonly title: string;
  readonly prompt: string;
  readonly repository: string;
  readonly model: string;
  readonly notBefore: string;
  readonly runtime: string;
  readonly verificationCommands: ReadonlyArray<GitsVerifyCommand>;
  readonly integrationBranch: string;
}

export interface LaunchModelOption {
  readonly value: string;
  readonly label: string;
}

export function readProposalLaunchStep(search: string): LaunchStep {
  const step = new URLSearchParams(search).get("proposalStep");
  return step === "model" || step === "review" ? step : "idea";
}

export type ProposalLaunchEdits = Omit<
  HermesProposalDecisionInput,
  "proposalId" | "decision" | "reason"
>;

export type ProposalLaunchValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly field: "repository" | "model" | "runtime" | "notBefore" | "verification";
      readonly message: string;
    };

const tierLabels = new Map<string, string>([
  [CODEX_MODEL_TIERS.light, "Luna · Light"],
  [CODEX_MODEL_TIERS.medium, "Terra · Balanced"],
  [CODEX_MODEL_TIERS.high, "Sol · Deep"],
]);
const padDatePart = (value: number) => String(value).padStart(2, "0");

function localDateTimeInput(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

export function launchModelOptions(policy: AutomodePolicy): ReadonlyArray<LaunchModelOption> {
  const models =
    policy.allowedModels.length > 0
      ? policy.allowedModels
      : [CODEX_MODEL_TIERS.light, CODEX_MODEL_TIERS.medium, CODEX_MODEL_TIERS.high];
  return [...new Set(models)].map((value) => ({ value, label: tierLabels.get(value) ?? value }));
}

export function isGuidedAutopilotProposal(proposal: HermesProposalCard): boolean {
  return (
    proposal.actionKind !== "read-only" &&
    proposal.recommendedExecutor === "delamain" &&
    proposal.blockedReason === null
  );
}

export function guidedAutopilotRepositories(policy: AutomodePolicy): ReadonlyArray<string> {
  return [...new Set([...policy.proposalRepos, ...policy.allowedRepos])];
}

export function initialProposalLaunchForm(
  proposal: HermesProposalCard,
  policy: AutomodePolicy,
): ProposalLaunchForm {
  const models = launchModelOptions(policy).map((option) => option.value);
  const model =
    proposal.model !== null && models.includes(proposal.model)
      ? proposal.model
      : policy.defaultModel !== null && models.includes(policy.defaultModel)
        ? policy.defaultModel
        : (models[0] ?? "");
  return {
    title: proposal.title,
    prompt: proposal.nextCommandOrPrompt ?? proposal.detail,
    repository: proposal.projectDir ?? policy.allowedRepos[0] ?? "",
    model,
    notBefore: proposal.notBefore === null ? "" : localDateTimeInput(proposal.notBefore),
    runtime:
      proposal.maxRuntimeMinutes !== null
        ? String(proposal.maxRuntimeMinutes)
        : policy.maxRuntimeMinutes !== null
          ? String(policy.maxRuntimeMinutes)
          : "",
    verificationCommands:
      proposal.verificationCommands.length > 0
        ? proposal.verificationCommands
        : policy.verificationCommands,
    integrationBranch: proposal.integrationBranch ?? policy.integrationBranch ?? "",
  };
}

export function validateProposalLaunchForm(form: ProposalLaunchForm): ProposalLaunchValidation {
  if (form.repository.trim().length === 0) {
    return { ok: false, field: "repository", message: "Choose a repository." };
  }
  if (form.model.trim().length === 0) {
    return { ok: false, field: "model", message: "Choose a model." };
  }
  if (form.runtime.length > 0) {
    const runtime = Number(form.runtime);
    if (!Number.isInteger(runtime) || runtime <= 0) {
      return { ok: false, field: "runtime", message: "Runtime must be at least one minute." };
    }
  }
  if (form.notBefore.length > 0 && Number.isNaN(new Date(form.notBefore).getTime())) {
    return { ok: false, field: "notBefore", message: "Choose a valid start time." };
  }
  if (
    form.verificationCommands.some(
      (command) =>
        command.label.trim().length === 0 ||
        command.cmd.length === 0 ||
        command.cmd.some((argument) => argument.trim().length === 0) ||
        (command.timeoutSeconds !== undefined &&
          (!Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 0)),
    )
  ) {
    return {
      ok: false,
      field: "verification",
      message: "Each verification check needs a label, non-empty arguments, and a valid timeout.",
    };
  }
  return { ok: true };
}

export function proposalLaunchEdits(form: ProposalLaunchForm): ProposalLaunchEdits {
  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    projectDir: form.repository.trim(),
    model: form.model.trim(),
    notBefore: form.notBefore.length > 0 ? new Date(form.notBefore).toISOString() : null,
    maxRuntimeMinutes: form.runtime.length > 0 ? Number(form.runtime) : null,
    verificationCommands: form.verificationCommands,
    integrationBranch: form.integrationBranch.trim() || null,
  };
}

export const TEST_PROPOSAL: HermesProposalCard = {
  id: "notification-test-proposal",
  episodeId: "notification-test-episode",
  title: "Improve the Android notification flow",
  summary: "Validate a proposal notification and guided launch without queueing real work.",
  detail: "Review the idea, choose a model, and confirm the queue summary.",
  evidence: ["Opened from a test PWA notification."],
  scope: ["Notification delivery", "Guided proposal review"],
  risk: "low",
  actionKind: "repo-write",
  status: "proposed",
  requiresApproval: true,
  recommendedExecutor: "delamain",
  verificationPlan: ["Complete the local test flow."],
  nextCommandOrPrompt: "Exercise the guided notification proposal flow.",
  blockedReason: null,
  source: "notification-test",
  projectDir: "/srv/example-project",
  model: CODEX_MODEL_TIERS.medium,
  notBefore: null,
  maxRuntimeMinutes: 45,
  verificationCommands: [],
  integrationBranch: null,
  sourceThreadId: null,
  decisionReason: null,
  decidedAt: null,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
};

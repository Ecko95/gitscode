/** Pure Autopilot panel logic: policy-form dirty-merge, model-tier display, gate-reason
 *  formatting, and the repo-allowlist warning check. No DOM, no React, no network. */

import {
  CODEX_MODEL_TIERS,
  type AutomodeMode,
  type AutomodePolicy,
  type AutomodePolicyUpdateInput,
  type CodexModelTier,
  type GitsSchedulerGateDecision,
  type GitsVerifierVerdict,
  type GitsVerifyCommand,
  type MotokoAuthority,
} from "@t3tools/contracts";

import { parseLines } from "../primitives";

const MODEL_TIER_KEYS = Object.keys(CODEX_MODEL_TIERS) as ReadonlyArray<CodexModelTier>;

/** Editable policy-form state — one field per `AutomodePolicy` input, plus the
 *  tier/free-text split for `defaultModel` and `allowedModels`. Numeric fields stay
 *  strings so the input can hold transient invalid text while the operator types. */
export interface AutopilotPolicyForm {
  readonly mode: AutomodeMode;
  readonly motokoAuthority: MotokoAuthority;
  readonly maxActivePeers: string;
  readonly defaultModelTier: CodexModelTier | "custom";
  readonly defaultModelCustom: string;
  readonly allowedModelTiers: ReadonlyArray<CodexModelTier>;
  readonly allowedModelsExtra: string;
  readonly allowedRepos: ReadonlyArray<string>;
  readonly maxBudgetUsd: string;
  readonly maxRuntimeMinutes: string;
  readonly requireApprovalForPeerSpawn: boolean;
  readonly requireApprovalBeforeIntegrate: boolean;
  readonly requireApprovalBeforeDestructiveAction: boolean;
  readonly integrationBranch: string;
  readonly verificationCommandsText: string;
}

/** Which fixed tier (if any) a model slug belongs to; `null` for a custom/unrecognized slug. */
export function modelTierOf(model: string | null | undefined): CodexModelTier | null {
  if (!model) return null;
  const match = (Object.entries(CODEX_MODEL_TIERS) as Array<[CodexModelTier, string]>).find(
    ([, slug]) => slug === model,
  );
  return match ? match[0] : null;
}

export function stringifyVerificationCommands(commands: ReadonlyArray<GitsVerifyCommand>): string {
  return commands.length === 0 ? "" : JSON.stringify(commands, null, 2);
}

export type ParsedVerificationCommands =
  | { readonly ok: true; readonly commands: ReadonlyArray<GitsVerifyCommand> }
  | { readonly ok: false; readonly error: string };

/** Verification commands are JSON-edited (argv arrays, not shell strings) — there is no
 *  existing structured-form UX to match, so this keeps the same "raw text, parse on save"
 *  shape as the other list fields (allowedRepos/allowedModels) instead of inventing one. */
export function parseVerificationCommands(text: string): ParsedVerificationCommands {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: true, commands: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Verification commands must be valid JSON." };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Verification commands must be a JSON array." };
  }
  for (const entry of parsed) {
    const label = (entry as { label?: unknown } | null)?.label;
    const cmd = (entry as { cmd?: unknown } | null)?.cmd;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof label !== "string" ||
      !Array.isArray(cmd) ||
      !cmd.every((part) => typeof part === "string")
    ) {
      return {
        ok: false,
        error: 'Each verification command needs a "label" string and a "cmd" array of strings.',
      };
    }
  }
  return { ok: true, commands: parsed as ReadonlyArray<GitsVerifyCommand> };
}

export function policyToFormState(policy: AutomodePolicy): AutopilotPolicyForm {
  const defaultTier = modelTierOf(policy.defaultModel);
  const allowedModelTiers = MODEL_TIER_KEYS.filter((tier) =>
    policy.allowedModels.includes(CODEX_MODEL_TIERS[tier]),
  );
  const allowedModelsExtra = policy.allowedModels
    .filter((model) => modelTierOf(model) === null)
    .join("\n");
  return {
    mode: policy.mode,
    motokoAuthority: policy.motokoAuthority,
    maxActivePeers: String(policy.maxActivePeers),
    defaultModelTier: defaultTier ?? (policy.defaultModel ? "custom" : "high"),
    defaultModelCustom: defaultTier ? "" : (policy.defaultModel ?? ""),
    allowedModelTiers,
    allowedModelsExtra,
    allowedRepos: policy.allowedRepos,
    maxBudgetUsd: policy.maxBudgetUsd === null ? "" : String(policy.maxBudgetUsd),
    maxRuntimeMinutes: policy.maxRuntimeMinutes === null ? "" : String(policy.maxRuntimeMinutes),
    requireApprovalForPeerSpawn: policy.requireApprovalForPeerSpawn,
    requireApprovalBeforeIntegrate: policy.requireApprovalBeforeIntegrate,
    requireApprovalBeforeDestructiveAction: policy.requireApprovalBeforeDestructiveAction,
    integrationBranch: policy.integrationBranch ?? "",
    verificationCommandsText: stringifyVerificationCommands(policy.verificationCommands),
  };
}

/** The clobber-bug fix (2026-07-07 audit finding #5), as a pure decision: while the
 *  operator has unsaved edits, ignore the poll; only reseed the form once it is pristine. */
export function nextPolicyFormState(
  current: AutopilotPolicyForm,
  policy: AutomodePolicy,
  dirty: boolean,
): AutopilotPolicyForm {
  return dirty ? current : policyToFormState(policy);
}

export type PolicyFormResult =
  | { readonly ok: true; readonly input: AutomodePolicyUpdateInput }
  | { readonly ok: false; readonly error: string };

export function formStateToPolicyUpdate(form: AutopilotPolicyForm): PolicyFormResult {
  const maxActivePeers = Math.max(0, Math.floor(Number(form.maxActivePeers)));
  if (!Number.isFinite(maxActivePeers)) {
    return { ok: false, error: "Max active peers must be a number." };
  }
  const maxBudgetUsd = form.maxBudgetUsd.trim().length === 0 ? null : Number(form.maxBudgetUsd);
  if (maxBudgetUsd !== null && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0)) {
    return { ok: false, error: "Max budget must be a non-negative number." };
  }
  const maxRuntimeMinutes =
    form.maxRuntimeMinutes.trim().length === 0
      ? null
      : Math.max(0, Math.floor(Number(form.maxRuntimeMinutes)));
  if (maxRuntimeMinutes !== null && !Number.isFinite(maxRuntimeMinutes)) {
    return { ok: false, error: "Max runtime must be a number." };
  }
  const verification = parseVerificationCommands(form.verificationCommandsText);
  if (!verification.ok) {
    return { ok: false, error: verification.error };
  }
  const defaultModel =
    form.defaultModelTier === "custom"
      ? form.defaultModelCustom.trim().length > 0
        ? form.defaultModelCustom.trim()
        : null
      : CODEX_MODEL_TIERS[form.defaultModelTier];
  const allowedModels = [
    ...form.allowedModelTiers.map((tier) => CODEX_MODEL_TIERS[tier]),
    ...parseLines(form.allowedModelsExtra),
  ];
  return {
    ok: true,
    input: {
      mode: form.mode,
      motokoAuthority: form.motokoAuthority,
      maxActivePeers,
      defaultModel,
      allowedModels,
      allowedRepos: form.allowedRepos.filter((repo) => repo.trim().length > 0),
      maxBudgetUsd,
      maxRuntimeMinutes,
      requireApprovalForPeerSpawn: form.requireApprovalForPeerSpawn,
      requireApprovalBeforeIntegrate: form.requireApprovalBeforeIntegrate,
      requireApprovalBeforeDestructiveAction: form.requireApprovalBeforeDestructiveAction,
      integrationBranch:
        form.integrationBranch.trim().length > 0 ? form.integrationBranch.trim() : null,
      verificationCommands: verification.commands as GitsVerifyCommand[],
    },
  };
}

/** Repos selected but missing from `allowedRepos` — the "won't run" diagnostic for the
 *  nightly-sweep repo picker. An empty `allowedRepos` means allow-all on the server
 *  (`AutomodeSupervisor.ts:201-204`, audit finding #9), so nothing is flagged in that case —
 *  the previous cockpit panel got this backwards and flagged every repo. */
export function reposNotAllowed(
  selected: ReadonlyArray<string>,
  allowedRepos: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (allowedRepos.length === 0) {
    return [];
  }
  return selected.filter(
    (repo) =>
      !allowedRepos.some(
        (allowed) =>
          repo === allowed || repo.startsWith(allowed.endsWith("/") ? allowed : `${allowed}/`),
      ),
  );
}

export function verdictTone(verdict: GitsVerifierVerdict): "success" | "warning" | "danger" {
  if (verdict === "pass") return "success";
  if (verdict === "fail") return "danger";
  return "warning";
}

/** "allowed" / "denied — reason" — the scheduler's last gate decision, minus the timestamp
 *  (the caller formats that with `formatIsoDate` so this stays deterministic to test). */
export function formatGateDecision(decision: GitsSchedulerGateDecision | null): string | null {
  if (!decision) return null;
  const verdict = decision.allowed ? "allowed" : "denied";
  return decision.reason ? `${verdict} — ${decision.reason}` : verdict;
}

import {
  CODEX_MODEL_TIERS,
  type CodexModelTier,
  type GitsSchedulerGateDecision,
} from "@t3tools/contracts";

export function modelTierOf(model: string | null | undefined): CodexModelTier | null {
  if (!model) return null;
  const match = (Object.entries(CODEX_MODEL_TIERS) as Array<[CodexModelTier, string]>).find(
    ([, slug]) => slug === model,
  );
  return match?.[0] ?? null;
}

export function formatGateDecision(decision: GitsSchedulerGateDecision | null): string | null {
  if (!decision) return null;
  const verdict = decision.allowed ? "allowed" : "denied";
  return decision.reason ? `${verdict} — ${decision.reason}` : verdict;
}

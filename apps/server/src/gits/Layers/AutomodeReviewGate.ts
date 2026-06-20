import type { GitsReviewResult } from "@t3tools/contracts";

export type AutomodeGateAction = "land" | "fail";

export interface AutomodeGateDecision {
  readonly action: AutomodeGateAction;
  readonly flagged: boolean;
  readonly reason: string;
}

// v1 (autoMerge OFF): land iff the mechanical suite passed AND the verifier did not
// reject. "uncertain" (or a skipped/absent semantic result) lands but is flagged for
// the operator's held-PR review. Only "fail" halts the chain.
export function decide_automode_gate(review: GitsReviewResult): AutomodeGateDecision {
  if (!review.mechanicalPassed) {
    return { action: "fail", flagged: false, reason: `Mechanical gate failed: ${review.summary}` };
  }
  const verdict = review.semantic?.verdict ?? "uncertain";
  if (verdict === "fail") {
    return {
      action: "fail",
      flagged: false,
      reason: `Verifier rejected the slice: ${review.summary}`,
    };
  }
  return { action: "land", flagged: verdict === "uncertain", reason: review.summary };
}

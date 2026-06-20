import { describe, expect, it } from "vitest";
import type { GitsReviewResult } from "@t3tools/contracts";
import { decide_automode_gate } from "./AutomodeReviewGate.ts";

function review(overrides: Partial<GitsReviewResult>): GitsReviewResult {
  const base: GitsReviewResult = {
    sliceId: "goal-1",
    recommendation: "hold-for-review",
    mechanicalPassed: true,
    mechanical: {
      worktree: "/tmp/wt",
      confined: true,
      passed: true,
      results: [],
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    semantic: {
      worktree: "/tmp/wt",
      verdict: "pass",
      confidence: "high",
      recommendation: "hold-for-review",
      reasons: [],
      missed: [],
      criteriaProvided: false,
      model: "gpt-5.5",
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    criteriaSource: "derived",
    summary: "ok",
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

describe("decide_automode_gate", () => {
  it("lands when mechanical passes and verdict is pass", () => {
    const d = decide_automode_gate(review({}));
    expect(d.action).toBe("land");
    expect(d.flagged).toBe(false);
  });

  it("fails when the mechanical gate fails (semantic null)", () => {
    const d = decide_automode_gate(review({ mechanicalPassed: false, semantic: null }));
    expect(d.action).toBe("fail");
  });

  it("fails when the verifier verdict is fail", () => {
    const d = decide_automode_gate(
      review({ semantic: { ...review({}).semantic!, verdict: "fail" } }),
    );
    expect(d.action).toBe("fail");
  });

  it("lands but flags when the verdict is uncertain", () => {
    const d = decide_automode_gate(
      review({ semantic: { ...review({}).semantic!, verdict: "uncertain" } }),
    );
    expect(d.action).toBe("land");
    expect(d.flagged).toBe(true);
  });

  it("treats a missing semantic result (mechanical passed) as uncertain -> land+flag", () => {
    const d = decide_automode_gate(review({ semantic: null }));
    expect(d.action).toBe("land");
    expect(d.flagged).toBe(true);
  });
});

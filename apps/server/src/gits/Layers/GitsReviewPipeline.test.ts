import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";

import { GitsReviewPipeline } from "../Services/GitsReviewPipeline.ts";
import { GitsVerificationGate } from "../Services/GitsVerificationGate.ts";
import { GitsSemanticVerifier } from "../Services/GitsSemanticVerifier.ts";
import { GitsSliceCriteriaStore } from "../Services/GitsSliceCriteriaStore.ts";
import { makeGitsReviewPipeline } from "./GitsReviewPipeline.ts";

const gateRun = vi.fn();
const verifierVerify = vi.fn();
const criteriaLoad = vi.fn();

const Stubs = Layer.mergeAll(
  Layer.succeed(GitsVerificationGate, GitsVerificationGate.of({ run: (i) => gateRun(i) })),
  Layer.succeed(
    GitsSemanticVerifier,
    GitsSemanticVerifier.of({ verify: (i) => verifierVerify(i) }),
  ),
  Layer.succeed(
    GitsSliceCriteriaStore,
    GitsSliceCriteriaStore.of({
      load: (i) => criteriaLoad(i),
      save: () => Effect.die("save unused in review pipeline"),
    }),
  ),
);

const TestLayer = Layer.effect(GitsReviewPipeline, makeGitsReviewPipeline).pipe(
  Layer.provide(Stubs),
);

const ISO = "2026-01-01T00:00:00.000Z";
const mech = (passed: boolean) => ({
  worktree: "/wt",
  confined: true,
  passed,
  results: [
    {
      label: "tsc",
      passed,
      exitCode: passed ? 0 : 1,
      timedOut: false,
      durationMs: 10,
      outputTail: "x",
    },
  ],
  checkedAt: ISO,
});
const sem = (
  verdict: "pass" | "fail" | "uncertain",
  confidence: "low" | "medium" | "high",
  recommendation: "auto-merge" | "hold-for-review",
  criteriaProvided = true,
) => ({
  worktree: "/wt",
  verdict,
  confidence,
  recommendation,
  reasons: [],
  missed: [],
  criteriaProvided,
  model: "gpt-5.4-mini",
  checkedAt: ISO,
});
const crit = (source: "authored" | "derived", acceptanceCriteria: ReadonlyArray<string> = []) => ({
  sliceId: "H1",
  title: "t",
  acceptanceCriteria,
  source,
});

const baseInput = {
  worktree: "/wt",
  baseRef: "origin/main",
  sliceId: "H1",
  verificationCommands: [{ label: "tsc", cmd: ["npx", "tsc", "--noEmit"] }],
};

afterEach(() => {
  gateRun.mockReset();
  verifierVerify.mockReset();
  criteriaLoad.mockReset();
});

describe("GitsReviewPipeline", () => {
  it.effect(
    "green gate + confident semantic pass → auto-merge, and the verifier gets the criteria",
    () =>
      Effect.gen(function* () {
        criteriaLoad.mockImplementation(() =>
          Effect.succeed(crit("authored", ["does X", "validates Y"])),
        );
        gateRun.mockImplementation(() => Effect.succeed(mech(true)));
        verifierVerify.mockImplementation((i) => {
          expect(i.acceptanceCriteria).toEqual(["does X", "validates Y"]);
          expect(i.baseRef).toBe("origin/main");
          return Effect.succeed(sem("pass", "high", "auto-merge"));
        });

        const pipeline = yield* GitsReviewPipeline;
        const r = yield* pipeline.review(baseInput);

        expect(r.mechanicalPassed).toBe(true);
        expect(r.recommendation).toBe("auto-merge");
        expect(r.semantic).not.toBeNull();
        expect(r.criteriaSource).toBe("authored");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("red gate → hold-for-review, and the semantic verifier is NOT run (saves codex)", () =>
    Effect.gen(function* () {
      criteriaLoad.mockImplementation(() => Effect.succeed(crit("authored", ["c"])));
      gateRun.mockImplementation(() => Effect.succeed(mech(false)));

      const pipeline = yield* GitsReviewPipeline;
      const r = yield* pipeline.review(baseInput);

      expect(r.mechanicalPassed).toBe(false);
      expect(r.recommendation).toBe("hold-for-review");
      expect(r.semantic).toBeNull();
      expect(verifierVerify).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("green gate + semantic hold → hold-for-review", () =>
    Effect.gen(function* () {
      criteriaLoad.mockImplementation(() => Effect.succeed(crit("authored", ["c"])));
      gateRun.mockImplementation(() => Effect.succeed(mech(true)));
      verifierVerify.mockImplementation(() =>
        Effect.succeed(sem("fail", "high", "hold-for-review")),
      );

      const pipeline = yield* GitsReviewPipeline;
      const r = yield* pipeline.review(baseInput);

      expect(r.recommendation).toBe("hold-for-review");
      expect(r.semantic?.verdict).toBe("fail");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("propagates derived criteria source when no criteria were authored", () =>
    Effect.gen(function* () {
      criteriaLoad.mockImplementation(() => Effect.succeed(crit("derived", [])));
      gateRun.mockImplementation(() => Effect.succeed(mech(true)));
      verifierVerify.mockImplementation(() =>
        Effect.succeed(sem("uncertain", "low", "hold-for-review", false)),
      );

      const pipeline = yield* GitsReviewPipeline;
      const r = yield* pipeline.review(baseInput);

      expect(r.criteriaSource).toBe("derived");
      expect(r.recommendation).toBe("hold-for-review");
    }).pipe(Effect.provide(TestLayer)),
  );
});

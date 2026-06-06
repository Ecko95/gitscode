import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { ProcessRunner, type ProcessRunnerShape } from "../../processRunner.ts";
import { GitsSemanticVerifier } from "../Services/GitsSemanticVerifier.ts";
import { makeGitsCodexVerifierAdapter } from "./GitsCodexVerifierAdapter.ts";

const runMock = vi.fn<ProcessRunnerShape["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({ run: (input) => runMock(input) }),
);

const TestLayer = Layer.effect(GitsSemanticVerifier, makeGitsCodexVerifierAdapter).pipe(
  Layer.provide(ProcessRunnerTest),
);

function execOk(code: number, stdout = "", stderr = "") {
  return Effect.succeed({
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

const DIFF = "diff --git a/x.ts b/x.ts\n+export const x = 1;";

afterEach(() => {
  runMock.mockReset();
  vi.unstubAllEnvs();
});

describe("GitsCodexVerifierAdapter", () => {
  it.effect(
    "computes the diff, runs a fresh read-only codex verifier, and auto-merges a confident pass",
    () =>
      Effect.gen(function* () {
        runMock.mockImplementationOnce((input) => {
          expect(input.command).toBe("git");
          expect(input.args).toEqual(["-C", "/wt", "diff", "origin/main..HEAD"]);
          return execOk(0, DIFF);
        });
        runMock.mockImplementationOnce((input) => {
          expect(input.command).toBe("codex");
          expect(input.args.slice(0, 5)).toEqual([
            "exec",
            "--sandbox",
            "read-only",
            "-m",
            "gpt-5.4-mini",
          ]);
          const prompt = input.args[4 + 1] ?? "";
          expect(prompt).toContain("UNTRUSTED DIFF");
          expect(prompt).toContain("must validate input");
          expect(input.env?.CODEX_HOME).toBeTruthy();
          return execOk(
            0,
            'here is my review\n{"verdict":"pass","confidence":"high","reasons":["meets all criteria"],"missed":[]}',
          );
        });

        const verifier = yield* GitsSemanticVerifier;
        const r = yield* verifier.verify({
          worktree: "/wt",
          baseRef: "origin/main",
          acceptanceCriteria: ["endpoint must validate input"],
          sliceTitle: "add validation",
          model: "gpt-5.4-mini",
        });

        expect(r.verdict).toBe("pass");
        expect(r.confidence).toBe("high");
        expect(r.recommendation).toBe("auto-merge");
        expect(r.criteriaProvided).toBe(true);
        expect(r.model).toBe("gpt-5.4-mini");
        expect(r.reasons).toEqual(["meets all criteria"]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("holds a fail for review and captures the missed criteria", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce(() => execOk(0, DIFF));
      runMock.mockImplementationOnce(() =>
        execOk(
          0,
          '{"verdict":"fail","confidence":"high","reasons":["ignores the empty-input case"],"missed":["validate input"]}',
        ),
      );
      const verifier = yield* GitsSemanticVerifier;
      const r = yield* verifier.verify({
        worktree: "/wt",
        baseRef: "origin/main",
        acceptanceCriteria: ["validate input"],
        sliceTitle: "x",
        model: "gpt-5.4-mini",
      });
      expect(r.verdict).toBe("fail");
      expect(r.recommendation).toBe("hold-for-review");
      expect(r.missed).toEqual(["validate input"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("holds even a confident pass when no acceptance criteria were provided", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce(() => execOk(0, DIFF));
      runMock.mockImplementationOnce(() =>
        execOk(0, '{"verdict":"pass","confidence":"high","reasons":["looks fine"],"missed":[]}'),
      );
      const verifier = yield* GitsSemanticVerifier;
      const r = yield* verifier.verify({
        worktree: "/wt",
        baseRef: "origin/main",
        acceptanceCriteria: [],
        sliceTitle: "x",
        model: "gpt-5.4-mini",
      });
      expect(r.criteriaProvided).toBe(false);
      expect(r.recommendation).toBe("hold-for-review");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("escalates to a stronger model once when the cheap tier is uncertain", () =>
    Effect.gen(function* () {
      vi.stubEnv("GITS_VERIFIER_ESCALATION_MODEL", "gpt-5.5");
      runMock.mockImplementationOnce(() => execOk(0, DIFF)); // diff
      runMock.mockImplementationOnce((input) => {
        expect(input.args[4]).toBe("gpt-5.4-mini");
        return execOk(
          0,
          '{"verdict":"uncertain","confidence":"low","reasons":["not sure"],"missed":[]}',
        );
      });
      runMock.mockImplementationOnce((input) => {
        expect(input.args[4]).toBe("gpt-5.5"); // escalated
        return execOk(
          0,
          '{"verdict":"pass","confidence":"high","reasons":["clear on review"],"missed":[]}',
        );
      });
      const verifier = yield* GitsSemanticVerifier;
      const r = yield* verifier.verify({
        worktree: "/wt",
        baseRef: "origin/main",
        acceptanceCriteria: ["c"],
        sliceTitle: "x",
        model: "gpt-5.4-mini",
      });
      expect(r.model).toBe("gpt-5.5");
      expect(r.verdict).toBe("pass");
      expect(r.recommendation).toBe("auto-merge");
      expect(runMock).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("falls back to uncertain+hold when codex output has no parseable verdict", () =>
    Effect.gen(function* () {
      vi.stubEnv("GITS_VERIFIER_ESCALATION_MODEL", "gpt-5.5");
      runMock.mockImplementationOnce(() => execOk(0, DIFF)); // diff
      runMock.mockImplementationOnce(() => execOk(0, "the model rambled with no json")); // uncertain
      runMock.mockImplementationOnce(() => execOk(0, "still no json")); // escalation also unparseable
      const verifier = yield* GitsSemanticVerifier;
      const r = yield* verifier.verify({
        worktree: "/wt",
        baseRef: "origin/main",
        acceptanceCriteria: ["c"],
        sliceTitle: "x",
        model: "gpt-5.4-mini",
      });
      expect(r.verdict).toBe("uncertain");
      expect(r.recommendation).toBe("hold-for-review");
    }).pipe(Effect.provide(TestLayer)),
  );
});

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { ProcessRunner, type ProcessRunnerShape } from "../../processRunner.ts";
import { GitsVerificationGate } from "../Services/GitsVerificationGate.ts";
import { makeGitsConfinedVerifyAdapter } from "./GitsConfinedVerifyAdapter.ts";

const runMock = vi.fn<ProcessRunnerShape["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);

const TestLayer = Layer.effect(GitsVerificationGate, makeGitsConfinedVerifyAdapter).pipe(
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

afterEach(() => {
  runMock.mockReset();
});

describe("GitsConfinedVerifyAdapter", () => {
  it.effect(
    "runs each command through the verify-profile confine wrapper and aggregates pass",
    () =>
      Effect.gen(function* () {
        // 1) bwrap probe
        runMock.mockImplementationOnce((input) => {
          expect(input.command).toBe("bwrap");
          expect(input.args).toEqual(["--version"]);
          return execOk(0, "bubblewrap 0.9.0");
        });
        // 2) first verification command, wrapped + server-pinned
        runMock.mockImplementationOnce((input) => {
          expect(input.command).toBe("gits-confine.sh");
          expect(input.args).toEqual([
            "--worktree",
            "/wt",
            "--profile",
            "verify",
            "--label",
            "lint",
            "--",
            "npx",
            "eslint",
            ".",
          ]);
          expect(input.shell).toBe(false);
          expect(input.cwd).toBe("/wt");
          return execOk(0, "lint ok");
        });
        // 3) second command
        runMock.mockImplementationOnce(() => execOk(0, "tsc ok"));

        const gate = yield* GitsVerificationGate;
        const result = yield* gate.run({
          worktree: "/wt",
          commands: [
            { label: "lint", cmd: ["npx", "eslint", "."] },
            { label: "tsc", cmd: ["npx", "tsc", "--noEmit"] },
          ],
        });

        expect(result.confined).toBe(true);
        expect(result.passed).toBe(true);
        expect(result.results.map((r) => r.label)).toEqual(["lint", "tsc"]);
        expect(result.results.every((r) => r.passed)).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports a failing command without halting the suite", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce(() => execOk(0, "bubblewrap 0.9.0")); // probe
      runMock.mockImplementationOnce(() => execOk(0, "lint ok")); // lint pass
      runMock.mockImplementationOnce(() => execOk(1, "", "tsc: 3 errors")); // tsc fail

      const gate = yield* GitsVerificationGate;
      const result = yield* gate.run({
        worktree: "/wt",
        commands: [
          { label: "lint", cmd: ["npx", "eslint", "."] },
          { label: "tsc", cmd: ["npx", "tsc", "--noEmit"] },
        ],
      });

      expect(result.passed).toBe(false);
      const tsc = result.results.find((r) => r.label === "tsc");
      expect(tsc?.passed).toBe(false);
      expect(tsc?.exitCode).toBe(1);
      expect(tsc?.outputTail).toContain("tsc: 3 errors");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails closed when bwrap is unavailable and confinement is required", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce(() => execOk(127)); // probe: bwrap missing

      const gate = yield* GitsVerificationGate;
      const error = yield* gate
        .run({ worktree: "/wt", commands: [{ label: "lint", cmd: ["npx", "eslint", "."] }] })
        .pipe(Effect.flip);

      expect(error._tag).toBe("GitsVerificationGateError");
      // no command should have run — only the probe
      expect(runMock).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("runs unconfined only when requireConfinement is explicitly false", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce(() => execOk(127)); // probe: bwrap missing
      runMock.mockImplementationOnce((input) => {
        // unconfined: the program is invoked directly, not via the wrapper
        expect(input.command).toBe("npx");
        expect(input.args).toEqual(["eslint", "."]);
        return execOk(0, "lint ok");
      });

      const gate = yield* GitsVerificationGate;
      const result = yield* gate.run({
        worktree: "/wt",
        commands: [{ label: "lint", cmd: ["npx", "eslint", "."] }],
        requireConfinement: false,
      });

      expect(result.confined).toBe(false);
      expect(result.passed).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

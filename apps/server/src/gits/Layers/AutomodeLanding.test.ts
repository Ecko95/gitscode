import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { AutomodeLandingLive } from "./AutomodeLanding.ts";

function gitDriverMock(
  handler: (args: ReadonlyArray<string>) => { exitCode: number; stderr?: string },
) {
  return Layer.mock(GitVcsDriver)({
    execute: (input) =>
      Effect.sync(() => {
        const { exitCode, stderr } = handler(input.args);
        return {
          exitCode: ChildProcessSpawner.ExitCode(exitCode),
          stdout: "",
          stderr: stderr ?? "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
}

const landInput = {
  repo: "/tmp/repo",
  integrationBranch: "auto/gits-self",
  baseRef: "gits",
  sliceBranch: "auto/slice/goal-1",
};

describe("AutomodeLandingLive", () => {
  it.effect("fast-forwards the integration branch when it already exists", () =>
    Effect.gen(function* () {
      const landing = yield* AutomodeLanding;
      const result = yield* landing.land_slice(landInput);
      assert.equal(result.status, "landed");
    }).pipe(
      Effect.provide(
        AutomodeLandingLive.pipe(
          Layer.provide(
            gitDriverMock((args) => {
              if (args[0] === "ls-remote") return { exitCode: 0 }; // exists
              return { exitCode: 0 };
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("creates the integration branch first when ls-remote reports it absent", () =>
    Effect.gen(function* () {
      const landing = yield* AutomodeLanding;
      const result = yield* landing.land_slice(landInput);
      assert.equal(result.status, "landed");
    }).pipe(
      Effect.provide(
        AutomodeLandingLive.pipe(
          Layer.provide(
            gitDriverMock((args) => {
              if (args[0] === "ls-remote") return { exitCode: 2 }; // absent
              return { exitCode: 0 };
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("returns rejected (not an error) when the FF push is refused", () =>
    Effect.gen(function* () {
      const landing = yield* AutomodeLanding;
      const result = yield* landing.land_slice(landInput);
      assert.equal(result.status, "rejected");
    }).pipe(
      Effect.provide(
        AutomodeLandingLive.pipe(
          Layer.provide(
            gitDriverMock((args) => {
              if (args[0] === "ls-remote") return { exitCode: 0 };
              if (
                args[0] === "push" &&
                args.includes("refs/remotes/origin/auto/slice/goal-1:refs/heads/auto/gits-self")
              ) {
                return { exitCode: 1, stderr: "! [rejected] (non-fast-forward)" };
              }
              return { exitCode: 0 };
            }),
          ),
        ),
      ),
    ),
  );
});

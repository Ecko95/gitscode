import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  makeRtkGateway,
  resolveRtkSettings,
  type MakeRtkGatewayOptions,
  RtkGatewayCommandError,
  type RtkCommandResult,
} from "./RtkGateway.ts";

function makeCommandResult(
  input: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number | null;
    readonly timedOut?: boolean;
  } = {},
): RtkCommandResult {
  return {
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
    code: input.code === null ? null : ChildProcessSpawner.ExitCode(input.code ?? 0),
    timedOut: input.timedOut ?? false,
  };
}

const unusedSpawner = ChildProcessSpawner.make(() => Effect.die("unexpected RTK child process"));

function makeTestRtkGateway(options: MakeRtkGatewayOptions) {
  return makeRtkGateway(options).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unusedSpawner),
  );
}

describe("resolveRtkSettings", () => {
  it("prefers GITS_RTK_BIN and parses conservative truthy env flags", () => {
    expect(
      resolveRtkSettings({
        GITS_RTK_BIN: "  /opt/rtk  ",
        RTK_BIN: "/usr/bin/rtk",
        GITS_RTK_OUTPUT_GATEWAY: "true",
        GITS_RTK_REWRITE_TOOLS: "0",
        GITS_RTK_ULTRA_COMPACT: "ON",
      }),
    ).toEqual({
      binaryPath: "/opt/rtk",
      outputGatewayEnabled: true,
      rewriteToolsEnabled: false,
      ultraCompact: true,
    });
  });
});

describe("makeRtkGateway", () => {
  it.effect("reports availability without throwing when RTK is missing", () =>
    Effect.gen(function* () {
      const calls: Parameters<NonNullable<MakeRtkGatewayOptions["runCommand"]>>[0][] = [];
      const gateway = yield* makeTestRtkGateway({
        env: { GITS_RTK_OUTPUT_GATEWAY: "1" },
        runCommand: (input) => {
          calls.push(input);
          return Effect.fail(
            new RtkGatewayCommandError({
              message: "spawn rtk ENOENT",
            }),
          );
        },
      });

      const status = yield* gateway.getStatus;

      expect(status).toEqual({
        binaryPath: "rtk",
        outputGatewayEnabled: true,
        rewriteToolsEnabled: false,
        ultraCompact: false,
        enabled: true,
        available: false,
      });
      expect(calls).toEqual([
        {
          command: "rtk",
          args: ["--version"],
          timeout: "2 seconds",
        },
      ]);
    }),
  );

  it.effect("returns a rewritten command when RTK rewrites successfully", () =>
    Effect.gen(function* () {
      const calls: Parameters<NonNullable<MakeRtkGatewayOptions["runCommand"]>>[0][] = [];
      const gateway = yield* makeTestRtkGateway({
        env: { GITS_RTK_REWRITE_TOOLS: "1" },
        runCommand: (input) => {
          calls.push(input);
          return Effect.succeed(makeCommandResult({ stdout: "rtk git status" }));
        },
      });

      const rewritten = yield* gateway.rewriteCommand("git status");

      expect(rewritten).toEqual({
        command: "rtk git status",
        rewritten: true,
      });
      expect(calls).toEqual([
        {
          command: "rtk",
          args: ["rewrite", "git status"],
        },
      ]);
    }),
  );

  it.effect("returns a no-op rewrite when RTK declines", () =>
    Effect.gen(function* () {
      const gateway = yield* makeTestRtkGateway({
        env: { GITS_RTK_REWRITE_TOOLS: "1" },
        runCommand: () => Effect.succeed(makeCommandResult({ stdout: "git status\n" })),
      });

      const rewritten = yield* gateway.rewriteCommand("git status");

      expect(rewritten).toEqual({
        command: "git status",
        rewritten: false,
      });
    }),
  );

  it.effect("pipes text through RTK with ultra-compact output when enabled", () =>
    Effect.gen(function* () {
      const calls: Parameters<NonNullable<MakeRtkGatewayOptions["runCommand"]>>[0][] = [];
      const gateway = yield* makeTestRtkGateway({
        env: {
          GITS_RTK_OUTPUT_GATEWAY: "1",
          GITS_RTK_ULTRA_COMPACT: "yes",
        },
        runCommand: (input) => {
          calls.push(input);
          return Effect.succeed(makeCommandResult({ stdout: "2 failed tests" }));
        },
      });

      const output = yield* gateway.pipeText({
        filter: "vitest",
        text: "raw test output",
      });

      expect(output).toBe("2 failed tests");
      expect(calls).toEqual([
        {
          command: "rtk",
          args: ["pipe", "-f", "vitest", "--ultra-compact"],
          stdin: "raw test output",
        },
      ]);
    }),
  );

  it.effect("preserves original text when RTK output filtering fails", () =>
    Effect.gen(function* () {
      const gateway = yield* makeTestRtkGateway({
        env: { GITS_RTK_OUTPUT_GATEWAY: "1" },
        runCommand: () => Effect.succeed(makeCommandResult({ code: 1, stderr: "filter failed" })),
      });

      const output = yield* gateway.pipeText({
        filter: "tsc",
        text: "raw compiler output",
      });

      expect(output).toBe("raw compiler output");
    }),
  );
});

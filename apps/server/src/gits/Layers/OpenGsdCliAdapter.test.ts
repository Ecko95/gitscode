import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { ProcessRunner, type ProcessRunnerShape } from "../../processRunner.ts";
import { OpenGsdAdapter } from "../Services/OpenGsdAdapter.ts";
import { makeOpenGsdCliAdapter } from "./OpenGsdCliAdapter.ts";

const runMock = vi.fn<ProcessRunnerShape["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);

const TestLayer = Layer.effect(OpenGsdAdapter, makeOpenGsdCliAdapter).pipe(
  Layer.provide(ProcessRunnerTest),
);

afterEach(() => {
  runMock.mockReset();
});

describe("OpenGsdCliAdapter", () => {
  it.effect("uses truncating shared process execution for human-facing init output", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input).toMatchObject({
          command: "gsd-sdk",
          args: ["init", "@docs/prd.md", "--project-dir", "/tmp/project"],
          cwd: "/tmp/project",
          timeout: 1_234,
          maxOutputBytes: 8 * 1024 * 1024,
          outputMode: "truncate",
          truncatedMarker: "\n\n[truncated]",
          timeoutBehavior: "timedOutResult",
          shell: process.platform === "win32",
        });

        return Effect.succeed({
          stdout: "init output\n\n[truncated]",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: true,
          stderrTruncated: false,
        });
      });

      const adapter = yield* OpenGsdAdapter;
      const result = yield* adapter.initProject({
        input: "@docs/prd.md",
        projectDir: "/tmp/project",
        timeoutMs: 1_234,
      });

      expect(result.status).toBe("completed");
      expect(result.stdout).toBe("init output\n\n[truncated]");
      expect(result.signal).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("maps synthetic timeout results to the timed-out command status", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input).toMatchObject({
          command: "gsd-sdk",
          args: ["auto", "--project-dir", "/tmp/project"],
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        });

        return Effect.succeed({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: true,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });

      const adapter = yield* OpenGsdAdapter;
      const result = yield* adapter.runAuto({
        projectDir: "/tmp/project",
      });

      expect(result.status).toBe("timed-out");
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toBe("");
    }).pipe(Effect.provide(TestLayer)),
  );
});

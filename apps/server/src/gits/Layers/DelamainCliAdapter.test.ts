import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import {
  ProcessOutputLimitError,
  ProcessRunner,
  type ProcessRunnerShape,
} from "../../processRunner.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { makeDelamainCliAdapter } from "./DelamainCliAdapter.ts";

const runMock = vi.fn<ProcessRunnerShape["run"]>();

const ProcessRunnerTest = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({
    run: (input) => runMock(input),
  }),
);

const TestLayer = Layer.effect(DelamainAdapter, makeDelamainCliAdapter).pipe(
  Layer.provide(ProcessRunnerTest),
);

afterEach(() => {
  runMock.mockReset();
});

describe("DelamainCliAdapter", () => {
  it.effect("keeps machine-parsed JSON commands on raw output mode", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input).toMatchObject({
          command: "delamain",
          args: ["status", "peer-1"],
          timeout: 30_000,
          maxOutputBytes: 8 * 1024 * 1024,
          outputMode: "error",
          truncatedMarker: "",
          shell: process.platform === "win32",
        });

        return Effect.succeed({
          stdout: JSON.stringify({
            id: "peer-1",
            status: "running",
            engine: "codex",
            task: "Inspect gateway output",
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });

      const adapter = yield* DelamainAdapter;
      const peer = yield* adapter.getPeerStatus({ peerId: "peer-1" });

      expect(peer.id).toBe("peer-1");
      expect(peer.status).toBe("running");
      expect(peer.task).toBe("Inspect gateway output");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("uses truncating shared process execution for human-facing peer logs", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input).toMatchObject({
          command: "delamain",
          args: ["log", "peer-1", "12"],
          outputMode: "truncate",
          truncatedMarker: "\n\n[truncated]",
        });

        return Effect.succeed({
          stdout: "peer log\n\n[truncated]",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: true,
          stderrTruncated: false,
        });
      });

      const adapter = yield* DelamainAdapter;
      const log = yield* adapter.readPeerLog({ peerId: "peer-1", lines: 12 });

      expect(log.lines).toBe(12);
      expect(log.text).toBe("peer log\n\n[truncated]");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails oversized JSON responses instead of truncating them", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.fail(
          new ProcessOutputLimitError({
            command: "delamain",
            args: ["status", "peer-1"],
            stream: "stdout",
            maxBytes: 8 * 1024 * 1024,
          }),
        ),
      );

      const adapter = yield* DelamainAdapter;
      const error = yield* adapter.getPeerStatus({ peerId: "peer-1" }).pipe(Effect.flip);

      expect(error.message).toBe("Delamain command output exceeded 8388608 bytes.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("forwards confine/egress/yolo flags to `delamain spawn`", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.command).toBe("delamain");
        expect(input.args).toEqual([
          "spawn",
          "--repo",
          "/tmp/repo",
          "--prompt",
          "do the thing",
          "--yolo",
          "--confine",
          "--egress",
          "host",
        ]);
        return Effect.succeed({
          stdout: JSON.stringify({ id: "peer-x", status: "running", engine: "codex" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });
      const adapter = yield* DelamainAdapter;
      const peer = yield* adapter.spawnPeer({
        repo: "/tmp/repo",
        prompt: "do the thing",
        yolo: true,
        confine: true,
        egress: "host",
      });
      expect(peer.id).toBe("peer-x");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shells the pinned `run-workflow --detach` argv and parses workflow_id", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.command).toBe("delamain");
        expect(input.args).toEqual([
          "run-workflow",
          "/srv/delamain/workflows/automode-goal.ts",
          "--repo",
          "/tmp/repo",
          "--name",
          "Motoko Proposal - Verified (Automated) · Fix the bug",
          "--args-json",
          '{"title":"Fix the bug","prompt":"Episode: epi-1\\ndo it"}',
          "--detach",
        ]);
        return Effect.succeed({
          stdout: JSON.stringify({ workflow_id: "wf-9", status: "running", workflow: {} }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });
      const adapter = yield* DelamainAdapter;
      const result = yield* adapter.runGoalWorkflow({
        workflowScript: "/srv/delamain/workflows/automode-goal.ts",
        repo: "/tmp/repo",
        name: "Motoko Proposal - Verified (Automated) · Fix the bug",
        argsJson: '{"title":"Fix the bug","prompt":"Episode: epi-1\\ndo it"}',
      });
      expect(result.workflowId).toBe("wf-9");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reads leaf ids from the nested workflow.agentPeerIds alias", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.args).toEqual(["workflow", "wf-9"]);
        return Effect.succeed({
          // Real CLI nests ids under workflow.agentPeerIds.
          stdout: JSON.stringify({
            id: "wf-9",
            status: "completed",
            workflow: { label: "run", agentPeerIds: ["leaf-1", "leaf-2"] },
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });
      const adapter = yield* DelamainAdapter;
      const status = yield* adapter.workflowStatus({ workflowId: "wf-9" });
      expect(status.peerIds).toEqual(["leaf-1", "leaf-2"]);
      expect(status.label).toBe("run");
    }).pipe(Effect.provide(TestLayer)),
  );
});

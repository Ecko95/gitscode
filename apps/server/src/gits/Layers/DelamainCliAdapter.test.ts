import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { makeHermesEnv } from "./HermesCliAdapter.ts";
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

function workerInstance(input: {
  readonly instanceId: string;
  readonly driver: "codex" | "cursor";
  readonly enabled?: boolean;
  readonly environment: NodeJS.ProcessEnv;
}): ProviderInstance {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: ProviderDriverKind.make(input.driver),
    continuationIdentity: {
      driverKind: ProviderDriverKind.make(input.driver),
      continuationKey: `${input.driver}:instance:${input.instanceId}`,
    },
    displayName: input.instanceId,
    enabled: input.enabled ?? true,
    workerEnvironment: input.environment,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
}

function makeTestLayer(instances: ReadonlyArray<ProviderInstance> = []) {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  const RegistryTest = Layer.succeed(
    ProviderInstanceRegistry,
    ProviderInstanceRegistry.of({
      getInstance: (instanceId) => Effect.succeed(byId.get(instanceId)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.die("unused in Delamain adapter tests"),
    }),
  );
  return Layer.effect(DelamainAdapter, makeDelamainCliAdapter).pipe(
    Layer.provide(ProcessRunnerTest),
    Layer.provide(RegistryTest),
  );
}

const TestLayer = makeTestLayer();

afterEach(() => {
  runMock.mockReset();
  vi.unstubAllEnvs();
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

  it.effect("launches spawn with only the selected provider instance environment", () => {
    const personal = workerInstance({
      instanceId: "codex_personal",
      driver: "codex",
      environment: { CODEX_HOME: "/accounts/personal", OPENAI_ACCOUNT: "personal" },
    });
    const work = workerInstance({
      instanceId: "codex_work",
      driver: "codex",
      environment: { CODEX_HOME: "/accounts/work", OPENAI_ACCOUNT: "work" },
    });
    return Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.env).toEqual({
          CODEX_HOME: "/accounts/work",
          OPENAI_ACCOUNT: "work",
        });
        return Effect.succeed({
          stdout: JSON.stringify({ id: "peer-work", status: "running", engine: "codex" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });

      const adapter = yield* DelamainAdapter;
      yield* adapter.spawnPeer({
        repo: "/tmp/repo",
        prompt: "do work",
        engine: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
      });
    }).pipe(Effect.provide(makeTestLayer([personal, work])));
  });

  it.effect("launches workflows with only the selected provider instance environment", () => {
    const work = workerInstance({
      instanceId: "codex_work",
      driver: "codex",
      environment: { CODEX_HOME: "/accounts/work", OPENAI_ACCOUNT: "work" },
    });
    return Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.env).toEqual({
          CODEX_HOME: "/accounts/work",
          OPENAI_ACCOUNT: "work",
        });
        return Effect.succeed({
          stdout: JSON.stringify({ workflow_id: "wf-work", status: "running" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });

      const adapter = yield* DelamainAdapter;
      yield* adapter.runGoalWorkflow({
        workflowScript: "/srv/delamain/workflows/automode-goal.ts",
        repo: "/tmp/repo",
        name: "Work workflow",
        argsJson: '{"title":"Work"}',
        engine: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
      });
    }).pipe(Effect.provide(makeTestLayer([work])));
  });

  it.effect("keeps Hermes OAuth isolation outside repository worker routing", () => {
    vi.stubEnv("CODEX_HOME", "/accounts/personal-codex");
    const work = workerInstance({
      instanceId: "codex_work",
      driver: "codex",
      environment: { CODEX_HOME: "/accounts/work-codex" },
    });
    return Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.env?.CODEX_HOME).toBe("/accounts/work-codex");
        return Effect.succeed({
          stdout: JSON.stringify({ id: "peer-work", status: "running", engine: "codex" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });

      const adapter = yield* DelamainAdapter;
      yield* adapter.spawnPeer({
        repo: "/tmp/work/repo",
        prompt: "do work",
        engine: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
      });

      const hermesEnvironment = makeHermesEnv("/accounts/personal-hermes");
      expect(hermesEnvironment.HERMES_HOME).toBe("/accounts/personal-hermes");
      expect(hermesEnvironment.CODEX_HOME).toBe("/accounts/personal-codex");
      expect(process.env.CODEX_HOME).toBe("/accounts/personal-codex");
    }).pipe(Effect.provide(makeTestLayer([work])));
  });

  it.effect("rejects a missing selected provider instance before launching", () =>
    Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          stdout: JSON.stringify({ id: "wrong", status: "running", engine: "codex" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );
      const adapter = yield* DelamainAdapter;
      const error = yield* adapter
        .spawnPeer({
          repo: "/tmp/repo",
          prompt: "do work",
          engine: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_missing"),
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("codex_missing");
      expect(runMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects a provider instance whose driver does not match the requested engine", () => {
    const cursor = workerInstance({
      instanceId: "cursor_work",
      driver: "cursor",
      environment: { CURSOR_ACCOUNT: "work" },
    });
    return Effect.gen(function* () {
      runMock.mockReturnValueOnce(
        Effect.succeed({
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          stdout: JSON.stringify({ id: "wrong", status: "running", engine: "codex" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );
      const adapter = yield* DelamainAdapter;
      const error = yield* adapter
        .spawnPeer({
          repo: "/tmp/repo",
          prompt: "do work",
          engine: "codex",
          providerInstanceId: ProviderInstanceId.make("cursor_work"),
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("does not match requested engine 'codex'");
      expect(runMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeTestLayer([cursor])));
  });

  it.effect("rejects a workflow provider whose driver does not match the selected engine", () => {
    const cursor = workerInstance({
      instanceId: "cursor_work",
      driver: "cursor",
      environment: { CURSOR_ACCOUNT: "work" },
    });
    return Effect.gen(function* () {
      const adapter = yield* DelamainAdapter;
      const error = yield* adapter
        .runWorkflow({
          script: "/srv/delamain/workflows/automode-goal.ts",
          repo: "/tmp/repo",
          engine: "codex",
          providerInstanceId: ProviderInstanceId.make("cursor_work"),
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("does not match requested engine 'codex'");
      expect(runMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeTestLayer([cursor])));
  });

  it.effect("rejects a disabled selected provider instance before launching", () => {
    const disabled = workerInstance({
      instanceId: "codex_work",
      driver: "codex",
      enabled: false,
      environment: { CODEX_HOME: "/accounts/work" },
    });
    return Effect.gen(function* () {
      const adapter = yield* DelamainAdapter;
      const error = yield* adapter
        .spawnPeer({
          repo: "/tmp/repo",
          prompt: "do work",
          engine: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("disabled");
      expect(runMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeTestLayer([disabled])));
  });

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

  it.effect(
    "shells the pinned operator `run-workflow --detach` argv with argsJson passthrough",
    () =>
      Effect.gen(function* () {
        runMock.mockImplementationOnce((input) => {
          expect(input.command).toBe("delamain");
          expect(input.args).toEqual([
            "run-workflow",
            "/srv/delamain/workflows/automode-goal.ts",
            "--repo",
            "/tmp/repo",
            "--name",
            "Nightly sweep",
            "--args-json",
            '{"title":"Ship it"}',
            "--detach",
          ]);
          return Effect.succeed({
            stdout: JSON.stringify({ workflow_id: "wf-launch", status: "running", workflow: {} }),
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });
        const adapter = yield* DelamainAdapter;
        const result = yield* adapter.runWorkflow({
          script: "/srv/delamain/workflows/automode-goal.ts",
          repo: "/tmp/repo",
          name: "Nightly sweep",
          argsJson: '{"title":"Ship it"}',
        });
        expect(result.workflowId).toBe("wf-launch");
        expect(result.status).toBe("running");
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("omits --name/--args-json when the operator leaves them unset", () =>
    Effect.gen(function* () {
      runMock.mockImplementationOnce((input) => {
        expect(input.args).toEqual([
          "run-workflow",
          "/srv/delamain/workflows/automode-goal.ts",
          "--repo",
          "/tmp/repo",
          "--detach",
        ]);
        return Effect.succeed({
          stdout: JSON.stringify({ workflow_id: "wf-bare", status: "queued" }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      });
      const adapter = yield* DelamainAdapter;
      const result = yield* adapter.runWorkflow({
        script: "/srv/delamain/workflows/automode-goal.ts",
        repo: "/tmp/repo",
      });
      expect(result.workflowId).toBe("wf-bare");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects unparseable argsJson before shelling the CLI", () =>
    Effect.gen(function* () {
      const adapter = yield* DelamainAdapter;
      const error = yield* adapter
        .runWorkflow({
          script: "/srv/delamain/workflows/automode-goal.ts",
          repo: "/tmp/repo",
          argsJson: "{not json",
        })
        .pipe(Effect.flip);
      expect(error.message).toBe("run-workflow argsJson is not valid JSON.");
      expect(runMock).not.toHaveBeenCalled();
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

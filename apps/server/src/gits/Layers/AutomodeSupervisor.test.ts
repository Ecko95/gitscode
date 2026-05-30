import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { AutomodeBudgetUsage, DelamainPeer, DelamainPeerListResult } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";

const peer: DelamainPeer = {
  id: "peer-automode",
  name: "Automode Peer",
  engine: "codex",
  model: "gpt-5.5",
  status: "running",
  rawStatus: "running",
  integrationStatus: null,
  sourceRepo: "/tmp/source-repo",
  worktreePath: "/tmp/source-repo/.worktrees/peer-automode",
  branch: "codex-peer/peer-automode",
  baseBranch: "main",
  mergeBranch: "main",
  prUrl: null,
  task: "Automode task",
  lastEvent: "running",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
};

const emptyPeerList: DelamainPeerListResult = {
  capabilities: {
    available: true,
    binaryPath: "delamain",
    supported: ["list", "spawn"],
    unsupported: ["status", "log", "kill", "reply", "wait", "integrate"],
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
  peers: [],
};

const defaultBudgetUsage: AutomodeBudgetUsage = {
  source: "unavailable",
  totalCostUsd: null,
  totalProcessedTokens: null,
  updatedAt: null,
  note: "No provider cost events observed.",
};

function makeLayer(options?: {
  readonly peers?: ReadonlyArray<DelamainPeer>;
  readonly budgetUsage?: AutomodeBudgetUsage;
  readonly onSpawn?: (input: { readonly repo: string; readonly prompt: string }) => void;
  readonly baseDir?: string;
}) {
  return AutomodeSupervisorLive.pipe(
    Layer.provide(
      Layer.mock(DelamainAdapter)({
        listPeers: () =>
          Effect.succeed({
            ...emptyPeerList,
            peers: options?.peers ?? [],
          }),
        spawnPeer: (input) =>
          Effect.sync(() => {
            options?.onSpawn?.(input);
            return {
              ...peer,
              name: input.name ?? peer.name,
              model: input.model ?? peer.model,
              sourceRepo: input.repo,
              task: input.prompt,
            };
          }),
        killPeer: () => Effect.succeed({ ...peer, status: "killed", rawStatus: "killed" }),
      }),
    ),
    Layer.provide(
      Layer.mock(AutomodeUsageMeter)({
        readBudgetUsage: () => Effect.succeed(options?.budgetUsage ?? defaultBudgetUsage),
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        options?.baseDir ?? { prefix: "gits-automode-supervisor-test-" },
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("AutomodeSupervisorLive", () => {
  it.effect("starts locked down by default", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const snapshot = yield* supervisor.getSnapshot();

      assert.equal(snapshot.policy.mode, "manual");
      assert.equal(snapshot.policy.killSwitchEnabled, true);
      assert.equal(snapshot.policy.requireApprovalForPeerSpawn, true);
      assert.equal(snapshot.budgetUsage.source, "unavailable");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("blocks dispatch when the kill switch is enabled", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const queued = yield* supervisor.enqueueGoal({
        title: "Blocked goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.peer, null);
      assert.equal(result.approvalRequired, false);
      assert.equal(result.blockedReason, "Kill switch is enabled.");
      assert.equal(result.goal.status, "blocked");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("requires approval in supervised mode before spawning", () => {
    let spawnCount = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "supervised",
        killSwitchEnabled: false,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Supervised goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const held = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });
      assert.equal(held.approvalRequired, true);
      assert.equal(held.peer, null);
      assert.equal(held.goal.status, "waiting-approval");

      yield* supervisor.approveGoal({ goalId: held.goal.id });
      const dispatched = yield* supervisor.dispatchGoal({ goalId: held.goal.id });

      assert.equal(dispatched.peer?.id, peer.id);
      assert.equal(dispatched.goal.status, "running");
      assert.equal(spawnCount, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          onSpawn: () => {
            spawnCount += 1;
          },
        }),
      ),
    );
  });

  it.effect("enforces repo, model, and active peer policy before autonomous spawn", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/allowed"],
        allowedModels: ["gpt-5.5"],
        defaultModel: "gpt-5.5",
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Out of bounds",
        repo: "/tmp/blocked",
        prompt: "Run a safe task.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.peer, null);
      assert.equal(result.blockedReason, "Repository is outside the automode allowlist.");
      assert.equal(result.goal.status, "blocked");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("spawns through Delamain when autonomous policy passes", () => {
    let spawnedRepo: string | null = null;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        allowedModels: ["gpt-5.5"],
        defaultModel: "gpt-5.5",
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Autonomous goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.peer?.id, peer.id);
      assert.equal(result.goal.peerId, peer.id);
      assert.equal(spawnedRepo, "/tmp/source-repo");
    }).pipe(
      Effect.provide(
        makeLayer({
          onSpawn: (input) => {
            spawnedRepo = input.repo;
          },
        }),
      ),
    );
  });

  it.effect("persists policy and queued goals across supervisor restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "gits-automode-persist-test-",
      });

      const firstSnapshot = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.updatePolicy({
          mode: "supervised",
          killSwitchEnabled: false,
          allowedRepos: ["/tmp/source-repo"],
          allowedModels: ["gpt-5.5"],
          defaultModel: "gpt-5.5",
        });
        return yield* supervisor.enqueueGoal({
          title: "Persisted goal",
          repo: "/tmp/source-repo",
          prompt: "Run after restart.",
          model: "gpt-5.5",
        });
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      const secondSnapshot = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        return yield* supervisor.getSnapshot();
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      assert.equal(firstSnapshot.goals[0]?.title, "Persisted goal");
      assert.equal(secondSnapshot.policy.mode, "supervised");
      assert.equal(secondSnapshot.policy.killSwitchEnabled, false);
      assert.deepEqual(secondSnapshot.policy.allowedRepos, ["/tmp/source-repo"]);
      assert.equal(secondSnapshot.goals[0]?.title, "Persisted goal");
      assert.equal(secondSnapshot.goals[0]?.prompt, "Run after restart.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blocks dispatch at the active peer limit", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Limit goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.peer, null);
      assert.equal(result.blockedReason, "Active peer limit reached (1).");
      assert.equal(result.goal.status, "blocked");
    }).pipe(Effect.provide(makeLayer({ peers: [peer] }))),
  );

  it.effect("blocks dispatch when a budget is configured but provider cost is unavailable", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxBudgetUsd: 10,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Budget telemetry goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.peer, null);
      assert.equal(
        result.blockedReason,
        "Budget limit is set but provider cost telemetry is unavailable.",
      );
      assert.equal(result.goal.status, "blocked");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("blocks dispatch when provider cost has reached the configured budget", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxBudgetUsd: 1.25,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Budget exhausted goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.peer, null);
      assert.equal(result.blockedReason, "Budget limit reached ($1.25 / $1.25).");
      assert.equal(result.goal.status, "blocked");
    }).pipe(
      Effect.provide(
        makeLayer({
          budgetUsage: {
            source: "provider-runtime",
            totalCostUsd: 1.25,
            totalProcessedTokens: 42_000,
            updatedAt: "2026-01-01T00:01:00.000Z",
            note: null,
          },
        }),
      ),
    ),
  );
});

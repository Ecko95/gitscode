import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type {
  AutomodeBudgetUsage,
  DelamainPeer,
  DelamainPeerListResult,
  DelamainSendMessageInput,
  DelamainSpawnPeerInput,
} from "@t3tools/contracts";

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

// Cost telemetry present and well under budget — lets autonomous dispatch proceed.
const availableBudgetUsage: AutomodeBudgetUsage = {
  source: "provider-runtime",
  totalCostUsd: 0,
  totalProcessedTokens: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  note: null,
};

function makeLayer(options?: {
  readonly peers?: ReadonlyArray<DelamainPeer>;
  readonly budgetUsage?: AutomodeBudgetUsage;
  readonly onSpawn?: (input: DelamainSpawnPeerInput) => void;
  readonly onSend?: (input: DelamainSendMessageInput) => void;
  readonly onKill?: () => void;
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
        killPeer: () =>
          Effect.sync(() => {
            options?.onKill?.();
            return { ...peer, status: "killed", rawStatus: "killed" } as DelamainPeer;
          }),
        sendMessage: (input) =>
          Effect.sync(() => {
            options?.onSend?.(input);
            return { responseId: input.responseId ?? null, delivered: 1, skipped: null };
          }),
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
        allowedRepos: ["/tmp/source-repo"],
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
        maxBudgetUsd: 10,
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
        maxBudgetUsd: 10,
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
          budgetUsage: availableBudgetUsage,
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
      // Boot always re-arms the kill switch, even though it was persisted as off.
      assert.equal(secondSnapshot.policy.killSwitchEnabled, true);
      assert.deepEqual(secondSnapshot.policy.allowedRepos, ["/tmp/source-repo"]);
      assert.equal(secondSnapshot.goals[0]?.title, "Persisted goal");
      assert.equal(secondSnapshot.goals[0]?.prompt, "Run after restart.");
      assert.equal(secondSnapshot.goals[0]?.approvedAt, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "boot never auto-resumes: persisted autonomous + killswitch-off + approved goal is re-armed",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "gits-automode-rearm-test-",
        });

        yield* Effect.gen(function* () {
          const supervisor = yield* AutomodeSupervisor;
          yield* supervisor.updatePolicy({
            mode: "autonomous",
            killSwitchEnabled: false,
            allowedRepos: ["/tmp/source-repo"],
            maxBudgetUsd: 10,
            requireApprovalForPeerSpawn: false,
          });
          const queued = yield* supervisor.enqueueGoal({
            title: "Incident goal",
            repo: "/tmp/source-repo",
            prompt: "Run a safe task.",
          });
          yield* supervisor.approveGoal({ goalId: queued.goals[0]!.id });
        }).pipe(Effect.provide(makeLayer({ baseDir })));

        const afterReboot = yield* Effect.gen(function* () {
          const supervisor = yield* AutomodeSupervisor;
          return yield* supervisor.getSnapshot();
        }).pipe(Effect.provide(makeLayer({ baseDir })));

        // The incident this guards: a persisted autonomous + killswitch-off policy with an
        // approved goal must NOT be able to dispatch on boot — it needs both a re-enable and
        // a re-approval from an operator first.
        assert.equal(afterReboot.policy.mode, "autonomous");
        assert.equal(afterReboot.policy.killSwitchEnabled, true);
        const goal = afterReboot.goals.find((g) => g.title === "Incident goal");
        assert.equal(goal?.approvedAt, null);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("repoAllowed: empty allowlist denies; a listed repo is allowed", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;

      // Empty allowedRepos (default) must deny, not allow-all.
      yield* supervisor.updatePolicy({
        mode: "supervised",
        killSwitchEnabled: false,
        maxRuntimeMinutes: null,
      });
      const deniedQueued = yield* supervisor.enqueueGoal({
        title: "Deny me",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });
      const denied = yield* supervisor.dispatchGoal({ goalId: deniedQueued.goals[0]!.id });
      assert.equal(denied.blockedReason, "Repository is outside the automode allowlist.");
      assert.equal(denied.goal.status, "blocked");

      // Listing the repo explicitly allows it past the repo gate.
      yield* supervisor.updatePolicy({ allowedRepos: ["/tmp/source-repo"] });
      const allowedQueued = yield* supervisor.enqueueGoal({
        title: "Allow me",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });
      const allowed = yield* supervisor.dispatchGoal({ goalId: allowedQueued.goals[0]!.id });
      assert.notEqual(allowed.blockedReason, "Repository is outside the automode allowlist.");
      assert.equal(allowed.goal.status, "waiting-approval");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("blocks dispatch at the active peer limit", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
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
        allowedRepos: ["/tmp/source-repo"],
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
        allowedRepos: ["/tmp/source-repo"],
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

  it.effect("completeGoal transitions a running goal to completed", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Done goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });
      const dispatched = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });
      assert.equal(dispatched.goal.status, "running");

      const completed = yield* supervisor.completeGoal({ goalId: dispatched.goal.id });
      assert.equal(completed.status, "completed");

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.id === completed.id)?.status, "completed");
    }).pipe(Effect.provide(makeLayer({ budgetUsage: availableBudgetUsage }))),
  );

  it.effect("failGoal marks failed with reason; haltDriver/resumeDriver toggle the flag", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const queued = yield* supervisor.enqueueGoal({
        title: "Failing goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });
      const goalId = queued.goals[0]!.id;

      const failed = yield* supervisor.failGoal({ goalId, reason: "Peer crashed." });
      assert.equal(failed.status, "failed");
      assert.equal(failed.blockedReason, "Peer crashed.");

      const halted = yield* supervisor.haltDriver({ reason: "Halted after failure." });
      assert.equal(halted.driverHalted, true);
      assert.equal(halted.driverHaltedReason, "Halted after failure.");

      const resumed = yield* supervisor.resumeDriver();
      assert.equal(resumed.driverHalted, false);
      assert.equal(resumed.driverHaltedReason, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("driverHalted persists across supervisor restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gits-automode-halt-test-" });

      yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.haltDriver({ reason: "Persist me." });
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      const after = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        return yield* supervisor.getSnapshot();
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      assert.equal(after.driverHalted, true);
      assert.equal(after.driverHaltedReason, "Persist me.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("autonomous dispatch requests a confined --yolo peer", () => {
    let spawnInput: DelamainSpawnPeerInput | null = null;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Confined goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });
      yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });
      assert.equal(spawnInput?.confine, true);
      assert.equal(spawnInput?.yolo, true);
      assert.equal(spawnInput?.egress, "host");
    }).pipe(
      Effect.provide(
        makeLayer({
          budgetUsage: availableBudgetUsage,
          onSpawn: (input) => {
            spawnInput = input;
          },
        }),
      ),
    );
  });

  it.effect("persists verificationCommands + integrationBranch across restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gits-automode-held-test-" });

      yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.updatePolicy({
          mode: "autonomous",
          killSwitchEnabled: false,
          allowedRepos: ["/tmp/source-repo"],
          maxBudgetUsd: 10,
          integrationBranch: "auto/gits-self",
          verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
        });
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      const after = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        return yield* supervisor.getSnapshot();
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      assert.equal(after.policy.integrationBranch, "auto/gits-self");
      assert.equal(after.policy.verificationCommands[0]?.label, "typecheck");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("defaults integrationBranch null + verificationCommands empty", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.policy.integrationBranch, null);
      assert.deepEqual(snapshot.policy.verificationCommands, []);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("autonomous dispatch spawns from the integration tip to a per-slice branch", () => {
    let spawnInput: DelamainSpawnPeerInput | null = null;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        maxRuntimeMinutes: null,
        integrationBranch: "auto/gits-self",
        verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
        requireApprovalForPeerSpawn: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Slice goal",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });
      const goalId = queued.goals[0]!.id;
      yield* supervisor.dispatchGoal({ goalId });
      assert.equal(spawnInput?.startRef, "auto/gits-self");
      assert.equal(spawnInput?.mergeBranch, `auto/slice/${goalId}`);
    }).pipe(
      Effect.provide(
        makeLayer({
          budgetUsage: availableBudgetUsage,
          onSpawn: (input) => {
            spawnInput = input;
          },
        }),
      ),
    );
  });

  it.effect("records a held PR and marks the run merged; both persist across restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gits-automode-heldpr-test-" });

      yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.recordHeldPr({
          url: "https://github.com/Ecko95/gitscode/pull/30",
          number: 30,
        });
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      const afterRecord = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        return yield* supervisor.getSnapshot();
      }).pipe(Effect.provide(makeLayer({ baseDir })));
      assert.equal(afterRecord.heldPrNumber, 30);
      assert.equal(afterRecord.runMerged, false);

      yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.markRunMerged();
      }).pipe(Effect.provide(makeLayer({ baseDir })));

      const afterMerge = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        return yield* supervisor.getSnapshot();
      }).pipe(Effect.provide(makeLayer({ baseDir })));
      assert.equal(afterMerge.runMerged, true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("defaults held-PR run state empty", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.heldPrUrl, null);
      assert.equal(snapshot.heldPrNumber, null);
      assert.equal(snapshot.runMerged, false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects arming autonomous mode without a budget", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const error = yield* supervisor
        .updatePolicy({
          mode: "autonomous",
          killSwitchEnabled: false,
          allowedRepos: ["/tmp/source-repo"],
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "AutomodeSupervisorError");
      assert.include(error.message, "max budget");

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.policy.mode, "manual");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects arming autonomous mode with an empty repo allowlist", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const error = yield* supervisor
        .updatePolicy({
          mode: "autonomous",
          killSwitchEnabled: false,
          maxBudgetUsd: 10,
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "AutomodeSupervisorError");
      assert.include(error.message, "allowlist");

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.policy.mode, "manual");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect(
    "applies autonomous policy validation inside serialized commit and preserves invariant under concurrent update",
    () =>
      Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.updatePolicy({
          mode: "supervised",
          killSwitchEnabled: false,
          allowedRepos: ["/tmp/source-repo"],
        });

        const makeAutonomous = Effect.result(
          supervisor.updatePolicy({
            mode: "autonomous",
            killSwitchEnabled: false,
            maxBudgetUsd: 10,
          }),
        );
        const clearAllowlist = Effect.result(supervisor.updatePolicy({ allowedRepos: [] }));

        const [clearResult, autonomousResult] = yield* Effect.all(
          [clearAllowlist, makeAutonomous],
          { concurrency: "unbounded" },
        );

        assert.equal(clearResult._tag, "Success");
        if (autonomousResult._tag === "Failure") {
          assert.include(autonomousResult.failure.message, "allowlist");
        }

        const snapshot = yield* supervisor.getSnapshot();
        assert.equal(
          snapshot.policy.mode === "autonomous" && snapshot.policy.allowedRepos.length === 0,
          false,
        );
      }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejectGoal transitions a waiting-approval goal to rejected", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "supervised",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxRuntimeMinutes: null,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Reject me",
        repo: "/tmp/source-repo",
        prompt: "Run a safe task.",
      });

      const held = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });
      assert.equal(held.goal.status, "waiting-approval");

      const rejected = yield* supervisor.rejectGoal({
        goalId: held.goal.id,
        reason: "Not this one.",
      });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.blockedReason, "Not this one.");
      assert.notEqual(rejected.rejectedAt, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("autonomous dispatch of a destructive prompt requires approval", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: true,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Destructive goal",
        repo: "/tmp/source-repo",
        prompt: "Clean up: rm -rf the build directory.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.approvalRequired, true);
      assert.equal(result.peer, null);
      assert.equal(result.goal.status, "waiting-approval");
    }).pipe(Effect.provide(makeLayer({ budgetUsage: availableBudgetUsage }))),
  );

  it.effect("autonomous dispatch of an integration-shaped prompt requires approval", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        maxRuntimeMinutes: null,
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: true,
        requireApprovalBeforeDestructiveAction: false,
      });
      const queued = yield* supervisor.enqueueGoal({
        title: "Integration goal",
        repo: "/tmp/source-repo",
        prompt: "Open a pull request with the change.",
      });

      const result = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });

      assert.equal(result.approvalRequired, true);
      assert.equal(result.peer, null);
      assert.equal(result.goal.status, "waiting-approval");
    }).pipe(Effect.provide(makeLayer({ budgetUsage: availableBudgetUsage }))),
  );

  it.effect(
    "kills the peer and blocks a running goal whose runtime deadline passed while down",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "gits-automode-deadline-test-",
        });
        const statePath = `${baseDir}/userdata/gits/automode-state.json`;
        let killCount = 0;

        const goalId = yield* Effect.gen(function* () {
          const supervisor = yield* AutomodeSupervisor;
          yield* supervisor.updatePolicy({
            mode: "autonomous",
            killSwitchEnabled: false,
            allowedRepos: ["/tmp/source-repo"],
            maxBudgetUsd: 10,
            maxRuntimeMinutes: 30,
            requireApprovalForPeerSpawn: false,
          });
          const queued = yield* supervisor.enqueueGoal({
            title: "Long runner",
            repo: "/tmp/source-repo",
            prompt: "Run a safe task.",
          });
          const dispatched = yield* supervisor.dispatchGoal({ goalId: queued.goals[0]!.id });
          assert.equal(dispatched.goal.status, "running");
          return dispatched.goal.id;
        }).pipe(Effect.provide(makeLayer({ baseDir, budgetUsage: availableBudgetUsage })));

        // Simulate downtime past the deadline: rewrite the persisted deadline into the past.
        const raw = yield* fs.readFileString(statePath);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        const persisted = JSON.parse(raw) as { runtimeDeadlines: Record<string, number> };
        assert.isNumber(persisted.runtimeDeadlines[goalId]);
        persisted.runtimeDeadlines[goalId] = -1;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* fs.writeFileString(statePath, JSON.stringify(persisted));

        const after = yield* Effect.gen(function* () {
          const supervisor = yield* AutomodeSupervisor;
          return yield* supervisor.getSnapshot();
        }).pipe(
          Effect.provide(
            makeLayer({
              baseDir,
              onKill: () => {
                killCount += 1;
              },
            }),
          ),
        );

        assert.equal(killCount, 1);
        const goal = after.goals.find((g) => g.id === goalId);
        assert.equal(goal?.status, "blocked");
        assert.equal(goal?.blockedReason, "Runtime limit reached and peer was terminated.");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sendPeerMessage: observe authority (default) blocks all sends", () => {
    let sent = false;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const failure = yield* Effect.flip(
        supervisor.sendPeerMessage({ toPeerId: "peer-x", message: "Hello peer" }),
      );
      assert.equal(
        failure.message,
        "Motoko authority is observe-only; peer messaging is disabled.",
      );
      assert.equal(sent, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          onSend: () => {
            sent = true;
          },
        }),
      ),
    );
  });

  it.effect("sendPeerMessage: respond authority blocks a new send but allows a reply", () => {
    const sent: DelamainSendMessageInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        requireApprovalForPeerSpawn: false,
        motokoAuthority: "respond",
      });

      const blocked = yield* Effect.flip(
        supervisor.sendPeerMessage({ toPeerId: "peer-x", message: "Fresh topic" }),
      );
      assert.equal(
        blocked.message,
        "Motoko authority allows replies only; new sends require dispatch authority.",
      );
      assert.equal(sent.length, 0);

      const reply = yield* supervisor.sendPeerMessage({
        toPeerId: "peer-x",
        message: "Re: your question",
        responseId: "resp-1",
      });
      assert.equal(reply.delivered, 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.responseId, "resp-1");
    }).pipe(
      Effect.provide(
        makeLayer({
          onSend: (input) => {
            sent.push(input);
          },
        }),
      ),
    );
  });

  it.effect("sendPeerMessage: dispatch authority reaches the Delamain adapter", () => {
    const sent: DelamainSendMessageInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        requireApprovalForPeerSpawn: false,
        motokoAuthority: "dispatch",
      });
      const result = yield* supervisor.sendPeerMessage({
        toPeerId: "peer-x",
        message: "Hello peer",
      });
      assert.equal(result.delivered, 1);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.toPeerId, "peer-x");
    }).pipe(
      Effect.provide(
        makeLayer({
          onSend: (input) => {
            sent.push(input);
          },
        }),
      ),
    );
  });

  it.effect("sendPeerMessage: defaults fromPeerId to motoko for GITS-originated sends", () => {
    const sent: DelamainSendMessageInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        requireApprovalForPeerSpawn: false,
        motokoAuthority: "dispatch",
      });
      yield* supervisor.sendPeerMessage({ toPeerId: "peer-x", message: "Hello peer" });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.fromPeerId, "motoko");
    }).pipe(
      Effect.provide(
        makeLayer({
          onSend: (input) => {
            sent.push(input);
          },
        }),
      ),
    );
  });

  it.effect("sendPeerMessage: shared gate still blocks a send when the kill switch is on", () => {
    let sent = false;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: true,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        requireApprovalForPeerSpawn: false,
        motokoAuthority: "dispatch",
      });
      const failure = yield* Effect.flip(
        supervisor.sendPeerMessage({ toPeerId: "peer-x", message: "Hello peer" }),
      );
      assert.equal(failure.message, "Kill switch is enabled.");
      assert.equal(sent, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          onSend: () => {
            sent = true;
          },
        }),
      ),
    );
  });

  it.effect("sendPeerMessage: destructive-shaped content requires human approval", () => {
    let sent = false;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 10,
        requireApprovalForPeerSpawn: false,
        motokoAuthority: "dispatch",
      });
      const failure = yield* Effect.flip(
        supervisor.sendPeerMessage({ toPeerId: "peer-x", message: "please rm -rf /tmp/scratch" }),
      );
      assert.equal(
        failure.message,
        "Manual approval required before Motoko can send this message.",
      );
      assert.equal(sent, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          onSend: () => {
            sent = true;
          },
        }),
      ),
    );
  });
});

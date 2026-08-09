import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import {
  AutomodeSupervisorError,
  GitsReviewError,
  GitsSlotSchedulerError,
  type DelamainPeer,
  type DelamainPeerListResult,
  type GitsReviewInput,
  type GitsReviewResult,
  type PeerStatus,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import {
  AutomodeSupervisor,
  type AutomodeSupervisorShape,
} from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeDriver } from "../Services/AutomodeDriver.ts";
import { AutomodeProposalSweep } from "../Services/AutomodeProposalSweep.ts";
import { AutomodeTelegramDigest } from "../Services/AutomodeTelegramDigest.ts";
import { CockpitInbox, type CockpitInboxRecordInput } from "../Services/CockpitInbox.ts";
import { HermesAdapter } from "../Services/HermesAdapter.ts";
import {
  HermesTelegramNotifier,
  HermesTelegramNotifierError,
  type HermesTelegramNotifierShape,
} from "../Services/HermesTelegramNotifier.ts";
import { AutomodeNotifications } from "./AutomodeNotifications.ts";
import { GitsReviewPipeline } from "../Services/GitsReviewPipeline.ts";
import {
  GitsSlotScheduler,
  type GitsSchedulerGateResult,
  type GitsSchedulerGoalStartInput,
} from "../Services/GitsSlotScheduler.ts";
import {
  AutomodeLanding,
  type AutomodeLandResult,
  type AutomodeLandSliceInput,
} from "../Services/AutomodeLanding.ts";
import {
  AutomodeHeldPr,
  type AutomodeOpenHeldPrInput,
  type AutomodeOpenHeldPrResult,
} from "../Services/AutomodeHeldPr.ts";
import {
  AutomodeEpisodeLedger,
  type AutomodeEpisode,
} from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";
import { AutomodeSupervisorTestRoutingLayer } from "./AutomodeSupervisor.testHelpers.ts";
import { AutomodeDriverLive } from "./AutomodeDriver.ts";

function makeReview(
  verdict: "pass" | "fail" | "uncertain",
  mechanicalPassed = true,
): GitsReviewResult {
  return {
    sliceId: "slice",
    recommendation: "hold-for-review",
    mechanicalPassed,
    mechanical: {
      worktree: "/tmp/wt",
      confined: true,
      passed: mechanicalPassed,
      results: [],
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    semantic: mechanicalPassed
      ? {
          worktree: "/tmp/wt",
          verdict,
          confidence: "high",
          recommendation: "hold-for-review",
          reasons: [],
          missed: [],
          criteriaProvided: false,
          model: "gpt-5.5",
          checkedAt: "2026-01-01T00:00:00.000Z",
        }
      : null,
    criteriaSource: "derived",
    summary: `verdict=${verdict}`,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

const passingReview = makeReview("pass");
const failingReview = makeReview("fail");

const basePeer: DelamainPeer = {
  id: "peer-driver",
  name: "Driver Peer",
  engine: "codex",
  model: "gpt-5.5",
  status: "running",
  rawStatus: "running",
  integrationStatus: null,
  sourceRepo: "/tmp/source-repo",
  worktreePath: "/tmp/source-repo/.worktrees/peer-driver",
  branch: "codex-peer/peer-driver",
  baseBranch: "gits",
  mergeBranch: "gits",
  prUrl: null,
  task: "Driver task",
  lastEvent: "running",
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
};

const emptyList: Omit<DelamainPeerListResult, "peers"> = {
  capabilities: {
    available: true,
    binaryPath: "delamain",
    supported: ["list", "spawn"],
    unsupported: ["status", "log", "kill", "reply", "wait", "integrate"],
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
};

interface MakeLayerOptions {
  readonly baseDir?: string;
  readonly review?: GitsReviewResult;
  readonly reviewError?: GitsReviewError;
  readonly onReview?: (input: GitsReviewInput) => void;
  readonly landResult?: AutomodeLandResult;
  readonly openResult?: AutomodeOpenHeldPrResult;
  readonly openHeldPrError?: AutomodeSupervisorError;
  readonly ensureError?: AutomodeSupervisorError;
  readonly onOpenHeldPr?: (input: AutomodeOpenHeldPrInput) => void;
  readonly mergeResults?: boolean[];
  readonly onRecordEpisode?: (episode: AutomodeEpisode) => void;
  readonly gateResult?: GitsSchedulerGateResult;
  readonly onRecordGoalStart?: (input: GitsSchedulerGoalStartInput) => void;
  readonly onSpawnPeer?: () => void;
  readonly recordGoalStartError?: GitsSlotSchedulerError;
  readonly onListPeers?: () => void;
  readonly onReadBudget?: () => void;
  // Workflow-dispatch mode: when set, dispatch shells runGoalWorkflow returning this id,
  // and the reconciled run-record peer (in listPeers) takes this id as well.
  readonly runGoalWorkflowId?: string;
  readonly workflowLeafIds?: string[];
  readonly leafPeer?: DelamainPeer;
  readonly onLandSlice?: (input: AutomodeLandSliceInput) => void;
  readonly onDigestTick?: () => void;
  readonly onNotify?: (input: Parameters<HermesTelegramNotifierShape["notify"]>[0]) => void;
  readonly notifyError?: HermesTelegramNotifierError;
  readonly onInbox?: (input: CockpitInboxRecordInput) => void;
  readonly onRefinePlan?: (boundary: string) => void;
  readonly onRetarget?: (eligibleAt: string | null) => void;
}

// Mutable holder so a test can change what listPeers returns between ticks.
function makeLayer(
  peerStatus: { current: PeerStatus | "absent"; integrationStatus?: string | null },
  options?: MakeLayerOptions,
) {
  // In workflow-dispatch mode the tracked peerId is the workflow run id, so the reconciled
  // run-record peer must carry that same id.
  const reconciledPeerId = options?.runGoalWorkflowId ?? basePeer.id;
  const spawnedPeerId = basePeer.id;
  const delamain = Layer.mock(DelamainAdapter)({
    listPeers: () =>
      Effect.sync(() => {
        options?.onListPeers?.();
        return {
          ...emptyList,
          peers:
            peerStatus.current === "absent"
              ? []
              : [
                  {
                    ...basePeer,
                    id: reconciledPeerId,
                    status: peerStatus.current,
                    rawStatus: peerStatus.current,
                    integrationStatus: peerStatus.integrationStatus ?? null,
                  },
                ],
        };
      }),
    spawnPeer: (input) =>
      Effect.sync(() => {
        options?.onSpawnPeer?.();
        return {
          ...basePeer,
          id: spawnedPeerId,
          name: input.name ?? basePeer.name,
          model: input.model ?? basePeer.model,
          sourceRepo: input.repo,
          task: input.prompt,
          status: "running",
          rawStatus: "running",
        };
      }),
    runGoalWorkflow: () =>
      Effect.sync(() => {
        options?.onSpawnPeer?.();
        return { workflowId: options?.runGoalWorkflowId ?? "wf-run" };
      }),
    workflowStatus: (input) =>
      Effect.succeed({
        id: input.workflowId,
        status: "completed",
        label: null,
        // Leaf ids nest under workflow.agentPeerIds on the wire; the adapter alias surfaces
        // them here as peerIds.
        peerIds: options?.workflowLeafIds ?? ["leaf-1"],
      }),
    getPeerStatus: (input) =>
      Effect.succeed(
        options?.leafPeer ?? {
          ...basePeer,
          id: input.peerId,
          worktreePath: `/tmp/source-repo/.worktrees/${input.peerId}`,
          branch: `codex-peer/${input.peerId}`,
          status: "done",
          rawStatus: "done",
        },
      ),
    killPeer: () => Effect.succeed({ ...basePeer, status: "killed", rawStatus: "killed" }),
  });
  const usage = Layer.mock(AutomodeUsageMeter)({
    // Telemetry available and under budget, so an armed autonomous policy can dispatch.
    readBudgetUsage: () =>
      Effect.sync(() => {
        options?.onReadBudget?.();
        return {
          source: "provider-runtime",
          totalCostUsd: 0,
          totalProcessedTokens: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
          note: null,
        };
      }),
  });
  const reviewPipeline = Layer.mock(GitsReviewPipeline)({
    review: (input) =>
      Effect.suspend(() => {
        options?.onReview?.(input);
        return options?.reviewError !== undefined
          ? Effect.fail(options.reviewError)
          : Effect.succeed(options?.review ?? passingReview);
      }),
  });
  const scheduler = Layer.mock(GitsSlotScheduler)({
    checkStartAllowed: () => Effect.succeed(options?.gateResult ?? { allowed: true as const }),
    recordGoalStart: (input) =>
      Effect.suspend(() => {
        options?.onRecordGoalStart?.(input);
        return options?.recordGoalStartError !== undefined
          ? Effect.fail(options.recordGoalStartError)
          : Effect.void;
      }),
    retargetApprovedGoal: ({ eligibleAt }) =>
      Effect.sync(() => {
        options?.onRetarget?.(eligibleAt);
        return {} as never;
      }),
  });
  const landing = Layer.mock(AutomodeLanding)({
    ensure_integration_branch: () =>
      options?.ensureError === undefined ? Effect.void : Effect.fail(options.ensureError),
    land_slice: (input) =>
      Effect.sync(() => {
        options?.onLandSlice?.(input);
        return options?.landResult ?? { status: "landed" };
      }),
  });
  const mergeQueue = [...(options?.mergeResults ?? [])];
  const heldPr = Layer.mock(AutomodeHeldPr)({
    open_held_pr: (input) =>
      Effect.suspend(() => {
        options?.onOpenHeldPr?.(input);
        if (options?.openHeldPrError !== undefined) {
          return Effect.fail(options.openHeldPrError);
        }
        return Effect.succeed(
          options?.openResult ?? {
            status: "opened" as const,
            url: "https://github.com/o/r/pull/30",
            number: 30,
          },
        );
      }),
    detect_merge: () => Effect.succeed({ merged: mergeQueue.shift() ?? false }),
  });
  const ledger = Layer.mock(AutomodeEpisodeLedger)({
    record_episode: (episode) =>
      Effect.sync(() => {
        options?.onRecordEpisode?.(episode);
      }),
    list_episodes: () => Effect.succeed([]),
  });
  const digest = Layer.mock(AutomodeTelegramDigest)({
    tick: () => Effect.sync(() => options?.onDigestTick?.()),
  });
  const proposalSweep = Layer.mock(AutomodeProposalSweep)({
    tick: () => Effect.void,
  });
  const notifier = Layer.mock(HermesTelegramNotifier)({
    notify: (input) =>
      Effect.suspend(() => {
        options?.onNotify?.(input);
        return options?.notifyError === undefined ? Effect.void : Effect.die(options.notifyError);
      }),
  });
  const notifications = Layer.mock(AutomodeNotifications)({
    notify: (input) =>
      Effect.suspend(() => {
        options?.onNotify?.(input);
        return options?.notifyError === undefined ? Effect.void : Effect.die(options.notifyError);
      }),
  });
  const inbox = Layer.mock(CockpitInbox)({
    record: (input) =>
      Effect.sync(() => {
        options?.onInbox?.(input);
        return {} as never;
      }),
    list: () => Effect.die("unused"),
    markRead: () => Effect.die("unused"),
    markAllRead: () => Effect.die("unused"),
    setPinned: () => Effect.die("unused"),
  });
  const hermes = Layer.mock(HermesAdapter)({
    refinePlan: ({ boundary }) =>
      Effect.sync(() => {
        options?.onRefinePlan?.(boundary);
        return "Split the task into one bounded retry change.";
      }),
  });
  const config = ServerConfig.layerTest(
    process.cwd(),
    options?.baseDir ?? { prefix: "gits-automode-driver-test-" },
  ).pipe(Layer.provide(NodeServices.layer));
  const supervisor = AutomodeSupervisorLive.pipe(
    Layer.provide(AutomodeSupervisorTestRoutingLayer),
    Layer.provide(delamain),
    Layer.provide(landing),
    Layer.provide(usage),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  return AutomodeDriverLive.pipe(
    Layer.provideMerge(supervisor),
    Layer.provide(delamain),
    Layer.provide(reviewPipeline),
    Layer.provide(scheduler),
    Layer.provide(landing),
    Layer.provide(heldPr),
    Layer.provide(ledger),
    Layer.provide(digest),
    Layer.provide(proposalSweep),
    Layer.provide(notifier),
    Layer.provide(notifications),
    Layer.provide(inbox),
    Layer.provide(hermes),
  );
}

function armAutonomous(supervisor: AutomodeSupervisorShape) {
  return supervisor.updatePolicy({
    mode: "autonomous",
    killSwitchEnabled: false,
    maxActivePeers: 1,
    allowedRepos: ["/tmp/source-repo"],
    maxBudgetUsd: 25,
    maxRuntimeMinutes: null,
    integrationBranch: "auto/gits-self",
    verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
    requireApprovalForPeerSpawn: false,
    requireApprovalBeforeIntegrate: false,
    requireApprovalBeforeDestructiveAction: false,
  });
}

function seedLegacyWorkflowGoal(baseDir: string, title: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const supervisor = yield* AutomodeSupervisor;
    const driver = yield* AutomodeDriver;
    yield* armAutonomous(supervisor);
    yield* supervisor.enqueueGoal({ title, repo: "/tmp/source-repo", prompt: "x" });
    yield* driver.tickOnce();

    const statePath = `${baseDir}/userdata/gits/automode-state.json`;
    const raw = yield* fs.readFileString(statePath);
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const persisted = JSON.parse(raw) as {
      goals: Array<{ title: string; peerId: string | null; workflowId: string | null }>;
    };
    const goal = persisted.goals.find((candidate) => candidate.title === title);
    assert.ok(goal);
    goal.peerId = "wf-run";
    goal.workflowId = "wf-run";
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    yield* fs.writeFileString(statePath, JSON.stringify(persisted));
  });
}

describe("AutomodeDriver", () => {
  it.effect("ticks the Telegram digest with each driver step", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let ticks = 0;
    return Effect.gen(function* () {
      const driver = yield* AutomodeDriver;
      yield* driver.tickOnce();
      assert.equal(ticks, 1);
    }).pipe(Effect.provide(makeLayer(peerStatus, { onDigestTick: () => ticks++ })));
  });

  it.effect("dispatches the oldest queued goal when idle and autonomous", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "First", repo: "/tmp/source-repo", prompt: "do it" });

      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      const goal = snapshot.goals.find((g) => g.title === "First");
      assert.equal(goal?.status, "running");
      assert.equal(goal?.peerId, "peer-driver");
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("keeps a proposal queued until its not-before time", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({
        title: "Scheduled",
        repo: "/tmp/source-repo",
        prompt: "do it later",
        notBefore: "2099-01-01T00:00:00.000Z",
      });

      yield* driver.tickOnce();

      assert.equal(
        (yield* supervisor.getSnapshot()).goals.find((goal) => goal.title === "Scheduled")?.status,
        "queued",
      );
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("does not dispatch a second goal while one is running (sequential)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "A", repo: "/tmp/source-repo", prompt: "a" });
      yield* supervisor.enqueueGoal({ title: "B", repo: "/tmp/source-repo", prompt: "b" });

      yield* driver.tickOnce(); // dispatch one
      peerStatus.current = "running"; // it's now in flight
      yield* driver.tickOnce(); // must NOT dispatch the second

      const snapshot = yield* supervisor.getSnapshot();
      const running = snapshot.goals.filter((g) => g.status === "running");
      assert.equal(running.length, 1);
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("reconciles a done peer to completed and advances", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Only", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch → running, peer "peer-driver"
      peerStatus.current = "done"; // peer finishes
      yield* driver.tickOnce(); // reconcile → completed

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Only")?.status, "completed");
      assert.equal(snapshot.driverHalted, false);
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("reconciles a failed peer to failed and halts the chain", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Boom", repo: "/tmp/source-repo", prompt: "x" });
      yield* supervisor.enqueueGoal({ title: "Next", repo: "/tmp/source-repo", prompt: "y" });

      yield* driver.tickOnce(); // dispatch "Boom"
      peerStatus.current = "failed";
      yield* driver.tickOnce(); // reconcile → failed + halt
      yield* driver.tickOnce(); // halted: must NOT dispatch "Next"

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Boom")?.status, "failed");
      assert.equal(snapshot.driverHalted, true);
      assert.equal(snapshot.goals.find((g) => g.title === "Next")?.status, "queued");
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("halts on a waiting peer without failing the goal", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Ask", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "waiting";
      yield* driver.tickOnce(); // reconcile → halt, goal still running

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Ask")?.status, "running");
      assert.equal(snapshot.driverHalted, true);
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("halts (does not silently advance) when the in-flight peer vanishes", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Gone", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch → running, peer "peer-driver"
      peerStatus.current = "running"; // it's in flight
      yield* driver.tickOnce(); // still running, peer visible
      peerStatus.current = "absent"; // peer vanished / reaped
      yield* driver.tickOnce(); // reconcile → must halt, not advance

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Gone")?.status, "running");
      assert.equal(snapshot.driverHalted, true);
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("does nothing when not autonomous", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      // policy left at default (mode "manual", kill switch on)
      yield* supervisor.enqueueGoal({ title: "Idle", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Idle")?.status, "queued");
    }).pipe(Effect.provide(makeLayer(peerStatus)));
  });

  it.effect("mode off: tick gates on policy alone — no getSnapshot IO (peer-list/budget)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let listPeersCalls = 0;
    let budgetCalls = 0;
    return Effect.gen(function* () {
      const driver = yield* AutomodeDriver;
      // policy left at default (mode "manual", kill switch on) — automode is off.
      yield* driver.tickOnce();

      // getSnapshot performs the peer-list subprocess + budget read; gating on the
      // cheap policy read first means neither runs on an idle tick.
      assert.equal(listPeersCalls, 0);
      assert.equal(budgetCalls, 0);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          onListPeers: () => {
            listPeersCalls += 1;
          },
          onReadBudget: () => {
            budgetCalls += 1;
          },
        }),
      ),
    );
  });

  it.effect("on done: verifier passes and slice lands → goal completed", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Gate", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // gate → land → complete

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Gate")?.status, "completed");
      assert.equal(snapshot.driverHalted, false);
    }).pipe(Effect.provide(makeLayer(peerStatus, { review: passingReview })));
  });

  it.effect("on done: verifier fails → goal failed and chain halts", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Bad", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // gate → fail + halt

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Bad")?.status, "failed");
      assert.equal(snapshot.driverHalted, true);
    }).pipe(Effect.provide(makeLayer(peerStatus, { review: failingReview })));
  });

  it.effect("on done: integration skipped (nothing pushed) → goal failed and chain halts", () => {
    const peerStatus = {
      current: "absent" as PeerStatus | "absent",
      integrationStatus: null as string | null,
    };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Empty", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      peerStatus.integrationStatus = "skipped"; // delamain: 0 commits ahead, branch never pushed
      yield* driver.tickOnce(); // must fail + halt, not attempt to review/land

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Empty")?.status, "failed");
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "no changes");
    }).pipe(Effect.provide(makeLayer(peerStatus, { review: passingReview })));
  });

  it.effect("on done: non-fast-forward landing → halts without completing", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Diverged", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // gate pass → land rejected → halt

      const snapshot = yield* supervisor.getSnapshot();
      assert.notEqual(snapshot.goals.find((g) => g.title === "Diverged")?.status, "completed");
      assert.equal(snapshot.driverHalted, true);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          review: passingReview,
          landResult: { status: "rejected", reason: "non-fast-forward" },
        }),
      ),
    );
  });

  it.effect("on done: empty policy verificationCommands → verify floor still runs (#154)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const reviews: GitsReviewInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 25,
        maxRuntimeMinutes: null,
        integrationBranch: "auto/gits-self",
        verificationCommands: [],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
      });
      yield* supervisor.enqueueGoal({ title: "Unverified", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // floor merged in → review runs → land → complete

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Unverified")?.status, "completed");
      assert.equal(snapshot.driverHalted, false);
      // The merged set is exactly the floor when policy contributes nothing.
      assert.deepEqual(
        reviews[0]?.verificationCommands.map((command) => command.label),
        ["fmt", "lint", "typecheck", "test", "build"],
      );
    }).pipe(Effect.provide(makeLayer(peerStatus, { onReview: (input) => reviews.push(input) })));
  });

  it.effect("verify-floor merge: a policy entry overrides the floor entry by label", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const reviews: GitsReviewInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor); // policy has typecheck: ["bun","typecheck"]
      yield* supervisor.enqueueGoal({ title: "Merged", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce();

      const commands = reviews[0]?.verificationCommands ?? [];
      const typecheck = commands.filter((command) => command.label === "typecheck");
      assert.equal(typecheck.length, 1); // merged, not duplicated
      assert.deepEqual(typecheck[0]?.cmd, ["bun", "typecheck"]); // policy wins on collision
      // Floor entries without a policy override survive the merge.
      assert.isDefined(commands.find((command) => command.label === "fmt"));
      assert.isDefined(commands.find((command) => command.label === "build"));
    }).pipe(Effect.provide(makeLayer(peerStatus, { onReview: (input) => reviews.push(input) })));
  });

  it.effect("opens a held PR when the queue drains with a landed goal", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let openCalls = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "One", repo: "/tmp/source-repo", prompt: "x" });
      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // gate → land → complete
      peerStatus.current = "absent";
      yield* driver.tickOnce(); // queue drained → open held PR

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.heldPrNumber, 30);
      assert.equal(openCalls, 1);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          onOpenHeldPr: () => {
            openCalls += 1;
          },
          openResult: {
            status: "opened",
            url: "https://github.com/o/r/pull/30",
            number: 30,
          },
        }),
      ),
    );
  });

  it.effect("polls the held PR and marks the run merged when GitHub reports merged", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "One", repo: "/tmp/source-repo", prompt: "x" });
      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // land + complete
      peerStatus.current = "absent";
      yield* driver.tickOnce(); // open held PR
      yield* driver.tickOnce(); // poll → not merged
      yield* driver.tickOnce(); // poll → merged

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.runMerged, true);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          openResult: {
            status: "opened",
            url: "https://github.com/o/r/pull/30",
            number: 30,
          },
          mergeResults: [false, true],
        }),
      ),
    );
  });

  it.effect("does not open a held PR when nothing landed (empty arm)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let openCalls = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor); // no goals enqueued
      yield* driver.tickOnce(); // drained, nothing landed
      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.heldPrUrl, null);
      assert.equal(openCalls, 0);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          onOpenHeldPr: () => {
            openCalls += 1;
          },
        }),
      ),
    );
  });

  it.effect("records an episode after a slice lands", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const episodes: AutomodeEpisode[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Ledger me", repo: "/tmp/source-repo", prompt: "x" });
      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // gate → land → complete → record episode

      assert.equal(episodes.length, 1);
      assert.equal(episodes[0]?.goalTitle, "Ledger me");
      assert.equal(episodes[0]?.verdict, "pass");
      assert.equal(episodes[0]?.repo, "/tmp/source-repo");
      // Episode thread (decision 23): the ledger row carries the goal's episodeId.
      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(episodes[0]?.episodeId, snapshot.goals[0]?.episodeId);
      assert.match(episodes[0]?.episodeId ?? "", /^epi-[0-9a-f-]{36}$/);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          review: passingReview,
          onRecordEpisode: (episode) => episodes.push(episode),
        }),
      ),
    );
  });

  it.effect("on done: no integration branch → lands on the goal's own branch, PR per goal", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const landed: AutomodeLandSliceInput[] = [];
    const opened: AutomodeOpenHeldPrInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 25,
        maxRuntimeMinutes: null,
        integrationBranch: null,
        verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
      });
      yield* supervisor.enqueueGoal({ title: "Own branch", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch — mints automode/goal-<uuid>
      peerStatus.current = "done";
      yield* driver.tickOnce(); // verify → land on the goal branch → complete → open PR

      const snapshot = yield* supervisor.getSnapshot();
      const goal = snapshot.goals.find((g) => g.title === "Own branch");
      assert.equal(goal?.status, "completed");
      assert.equal(snapshot.driverHalted, false);
      assert.match(goal?.branch ?? "", /^automode\/goal-[0-9a-f-]{36}$/);
      assert.equal(landed[0]?.integrationBranch, goal?.branch);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.integrationBranch, goal?.branch);
      assert.equal(opened[0]?.baseBranch, "gits");
      // The run-level held-PR record only serves shared-branch runs.
      assert.equal(snapshot.heldPrUrl, null);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          onLandSlice: (input) => landed.push(input),
          onOpenHeldPr: (input) => opened.push(input),
        }),
      ),
    );
  });

  it.effect("halts when the per-goal held PR cannot be opened (goal stays landed)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 25,
        maxRuntimeMinutes: null,
        integrationBranch: null,
        verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
      });
      yield* supervisor.enqueueGoal({ title: "PR fails", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // land + complete → PR open rejected → halt

      const snapshot = yield* supervisor.getSnapshot();
      // The slice already landed on its own branch — the goal stays completed; the halt
      // tells the operator the PR needs opening by hand.
      assert.equal(snapshot.goals.find((g) => g.title === "PR fails")?.status, "completed");
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "could not open held PR");
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          openResult: { status: "rejected", reason: "gh pr create failed" },
        }),
      ),
    );
  });

  it.effect("halts when the per-goal held PR open ERRORS (gh failure, not a rejection)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 25,
        maxRuntimeMinutes: null,
        integrationBranch: null,
        verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
      });
      yield* supervisor.enqueueGoal({ title: "gh down", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // land + complete → PR open fails on the error channel → halt

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "gh down")?.status, "completed");
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "held PR open errored");
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          openHeldPrError: new AutomodeSupervisorError({ message: "gh pr create failed." }),
        }),
      ),
    );
  });

  it.effect("opens the per-goal PR even when the policy integration branch changed mid-run", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const opened: AutomodeOpenHeldPrInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        maxBudgetUsd: 25,
        maxRuntimeMinutes: null,
        integrationBranch: null,
        verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
      });
      yield* supervisor.enqueueGoal({ title: "Mid-run", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch on a per-goal branch
      // Operator sets a shared integration branch while the peer is in flight — the
      // landed goal must still get ITS branch's PR, not silently lose it.
      yield* supervisor.updatePolicy({ integrationBranch: "auto/gits-self" });
      peerStatus.current = "done";
      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      const goal = snapshot.goals.find((g) => g.title === "Mid-run");
      assert.equal(goal?.status, "completed");
      assert.match(goal?.branch ?? "", /^automode\/goal-[0-9a-f-]{36}$/);
      assert.equal(opened.length, 1);
      assert.equal(opened[0]?.integrationBranch, goal?.branch);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          onOpenHeldPr: (input) => opened.push(input),
        }),
      ),
    );
  });

  it.effect("halts when dispatch errors (ensure fails) instead of silently retrying", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const starts: GitsSchedulerGoalStartInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Bad base", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // ensure fails → dispatch errors → halt (fail-closed)
      yield* driver.tickOnce(); // halted: must NOT retry and burn another night-cap slot

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "dispatch of Bad base errored");
      assert.equal(starts.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          ensureError: new AutomodeSupervisorError({ message: "git fetch origin gits failed." }),
          onRecordGoalStart: (input) => starts.push(input),
        }),
      ),
    );
  });

  it.effect("halts when the held PR cannot be opened", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "One", repo: "/tmp/source-repo", prompt: "x" });
      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // gate → land → complete
      peerStatus.current = "absent";
      yield* driver.tickOnce(); // queue drained → open held PR fails → halt

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.heldPrUrl, null);
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "could not open held PR");
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          openResult: { status: "rejected", reason: "gh pr create failed" },
        }),
      ),
    );
  });

  it.effect("scheduler deny → no dispatch, goal stays queued, no halt", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const starts: GitsSchedulerGoalStartInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Gated", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Gated")?.status, "queued");
      assert.equal(snapshot.driverHalted, false);
      assert.equal(starts.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          gateResult: {
            allowed: false,
            category: "schedule",
            reason: "Outside slot window (next slot 00:00)",
            retryAt: null,
          },
          onRecordGoalStart: (input) => starts.push(input),
        }),
      ),
    );
  });

  it.effect("known quota reset defers and refines once without dispatching", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const resetAt = "2099-01-02T00:00:00.000Z";
    const refinements: string[] = [];
    const retargets: Array<string | null> = [];
    const inbox: CockpitInboxRecordInput[] = [];
    let spawns = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Quota wait", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce();
      yield* driver.tickOnce();

      const goal = (yield* supervisor.getSnapshot()).goals[0]!;
      assert.equal(goal.status, "queued");
      assert.equal(goal.notBefore, resetAt);
      assert.equal(goal.planningBoundary, resetAt);
      assert.include(goal.planningNotes ?? "", "bounded retry change");
      assert.deepEqual(refinements, [resetAt]);
      assert.deepEqual(retargets, [resetAt]);
      assert.deepEqual(
        inbox.map((event) => event.state),
        ["waiting-quota-reset"],
      );
      assert.equal(spawns, 0);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          gateResult: {
            allowed: false,
            category: "quota",
            reason: "Codex weekly window at 92%",
            retryAt: resetAt,
          },
          onRefinePlan: (boundary) => refinements.push(boundary),
          onRetarget: (eligibleAt) => retargets.push(eligibleAt),
          onInbox: (event) => inbox.push(event),
          onSpawnPeer: () => {
            spawns += 1;
          },
        }),
      ),
    );
  });

  it.effect("missing quota telemetry records a wait without guessing a reset", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const inbox: CockpitInboxRecordInput[] = [];
    let refinements = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({
        title: "Telemetry wait",
        repo: "/tmp/source-repo",
        prompt: "x",
      });
      yield* driver.tickOnce();

      const goal = (yield* supervisor.getSnapshot()).goals[0]!;
      assert.equal(goal.notBefore, null);
      assert.equal(refinements, 0);
      assert.equal(inbox[0]?.eventKey, `goal:${goal.id}:waiting:telemetry`);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          gateResult: {
            allowed: false,
            category: "quota",
            reason: "Codex quota telemetry is missing or stale",
            retryAt: null,
          },
          onRefinePlan: () => {
            refinements += 1;
          },
          onInbox: (event) => inbox.push(event),
        }),
      ),
    );
  });

  it.effect("scheduler allow → dispatch + recordGoalStart with the goal's episodeId", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const starts: GitsSchedulerGoalStartInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Started", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      const goal = snapshot.goals.find((g) => g.title === "Started");
      assert.equal(goal?.status, "running");
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.goalId, goal?.id);
      assert.equal(starts[0]?.episodeId, goal?.episodeId);
    }).pipe(
      Effect.provide(makeLayer(peerStatus, { onRecordGoalStart: (input) => starts.push(input) })),
    );
  });

  it.effect("gate deny with a landed goal still opens the held PR (no starvation)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let openCalls = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Landed", repo: "/tmp/source-repo", prompt: "x" });
      yield* supervisor.enqueueGoal({ title: "Capped", repo: "/tmp/source-repo", prompt: "y" });
      const before = yield* supervisor.getSnapshot();
      const landedId = before.goals.find((g) => g.title === "Landed")?.id ?? "";
      yield* supervisor.dispatchGoal({ goalId: landedId }); // manual dispatch stays ungated

      peerStatus.current = "done";
      yield* driver.tickOnce(); // reconcile → land → complete (gate not consulted)
      peerStatus.current = "absent";
      yield* driver.tickOnce(); // "Capped" still queued + gate denies → held PR must still open

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.heldPrNumber, 30);
      assert.equal(openCalls, 1);
      assert.equal(snapshot.goals.find((g) => g.title === "Capped")?.status, "queued");
      assert.equal(snapshot.driverHalted, false);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          gateResult: {
            allowed: false,
            category: "schedule",
            reason: "Night goal cap reached (1)",
            retryAt: null,
          },
          onOpenHeldPr: () => {
            openCalls += 1;
          },
        }),
      ),
    );
  });

  it.effect("disabled-scheduler bypass dispatches without recording a goal start", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const starts: GitsSchedulerGoalStartInput[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Bypassed", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Bypassed")?.status, "running");
      assert.equal(starts.length, 0); // must NOT consume the night cap
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          gateResult: { allowed: true, bypassed: true },
          onRecordGoalStart: (input) => starts.push(input),
        }),
      ),
    );
  });

  it.effect("halts (fail-closed) when the scheduler cannot record a goal start", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let spawnCalls = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Uncounted", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "failed to record the start");
      assert.equal(snapshot.goals.find((g) => g.title === "Uncounted")?.status, "queued");
      assert.equal(spawnCalls, 0);
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          recordGoalStartError: new GitsSlotSchedulerError({ message: "scheduler disk full" }),
          onSpawnPeer: () => {
            spawnCalls += 1;
          },
        }),
      ),
    );
  });

  it.effect(
    "keeps the scheduler-recording halt and queued goal when Telegram alert delivery fails",
    () => {
      const peerStatus = { current: "absent" as PeerStatus | "absent" };
      const notifications: Parameters<HermesTelegramNotifierShape["notify"]>[0][] = [];
      return Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        const driver = yield* AutomodeDriver;
        yield* armAutonomous(supervisor);
        yield* supervisor.enqueueGoal({
          title: "Uncounted",
          repo: "/tmp/source-repo",
          prompt: "x",
        });

        yield* driver.tickOnce();

        const snapshot = yield* supervisor.getSnapshot();
        assert.equal(snapshot.driverHalted, true);
        assert.include(snapshot.driverHaltedReason ?? "", "failed to record the start");
        assert.equal(snapshot.goals.find((goal) => goal.title === "Uncounted")?.status, "queued");
        assert.equal(notifications.length, 1);
      }).pipe(
        Effect.provide(
          makeLayer(peerStatus, {
            recordGoalStartError: new GitsSlotSchedulerError({ message: "scheduler disk full" }),
            onNotify: (input) => notifications.push(input),
            notifyError: new HermesTelegramNotifierError({ message: "Telegram unavailable" }),
          }),
        ),
      );
    },
  );

  it.effect("held PR body lists each landed slice with its episode id", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    const bodies: string[] = [];
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Sliced", repo: "/tmp/source-repo", prompt: "x" });
      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // land + complete
      peerStatus.current = "absent";
      yield* driver.tickOnce(); // queue drained → open held PR

      const snapshot = yield* supervisor.getSnapshot();
      const goal = snapshot.goals.find((g) => g.title === "Sliced");
      assert.equal(bodies.length, 1);
      assert.include(bodies[0] ?? "", `- Sliced (episode ${goal?.episodeId})`);
    }).pipe(
      Effect.provide(makeLayer(peerStatus, { onOpenHeldPr: (input) => bodies.push(input.body) })),
    );
  });

  it.effect("verifier pipeline error (throw, not verdict) → goal failed and chain halts", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* armAutonomous(supervisor);
      yield* supervisor.enqueueGoal({ title: "Throwy", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce();

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.find((g) => g.title === "Throwy")?.status, "failed");
      assert.equal(snapshot.driverHalted, true);
      assert.include(snapshot.driverHaltedReason ?? "", "verifier errored");
    }).pipe(
      Effect.provide(
        makeLayer(peerStatus, {
          reviewError: new GitsReviewError({ message: "verifier exploded" }),
        }),
      ),
    );
  });

  it.effect(
    "reconciles a legacy workflow goal against the workflow run id as the tracked peer",
    () => {
      const peerStatus = { current: "absent" as PeerStatus | "absent" };
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gits-legacy-wf-driver-" });
        yield* seedLegacyWorkflowGoal(baseDir, "WF").pipe(
          Effect.provide(makeLayer(peerStatus, { baseDir })),
        );

        // The run record surfaces in listPeers under that id → reconcile keeps it running,
        // it does NOT hit the vanished-peer halt path.
        peerStatus.current = "running";
        const after = yield* Effect.gen(function* () {
          const supervisor = yield* AutomodeSupervisor;
          const driver = yield* AutomodeDriver;
          yield* supervisor.updatePolicy({ killSwitchEnabled: false });
          yield* driver.tickOnce();
          return yield* supervisor.getSnapshot();
        }).pipe(Effect.provide(makeLayer(peerStatus, { baseDir, runGoalWorkflowId: "wf-run" })));
        assert.equal(after.goals.find((g) => g.title === "WF")?.status, "running");
        assert.equal(after.driverHalted, false);
      }).pipe(Effect.provide(NodeServices.layer));
    },
  );

  it.effect("lands a legacy workflow's leaf branch resolved from workflow.agentPeerIds", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    let landInput: AutomodeLandSliceInput | null = null;
    let reviewWorktree: string | null = null;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gits-legacy-wf-land-" });
      yield* seedLegacyWorkflowGoal(baseDir, "WF land").pipe(
        Effect.provide(makeLayer(peerStatus, { baseDir })),
      );
      peerStatus.current = "done"; // run record finished
      const snapshot = yield* Effect.gen(function* () {
        const supervisor = yield* AutomodeSupervisor;
        const driver = yield* AutomodeDriver;
        yield* supervisor.updatePolicy({ killSwitchEnabled: false });
        yield* driver.tickOnce(); // resolve leaf → verify → land → complete
        return yield* supervisor.getSnapshot();
      }).pipe(
        Effect.provide(
          makeLayer(peerStatus, {
            baseDir,
            runGoalWorkflowId: "wf-run",
            workflowLeafIds: ["leaf-7"],
            onLandSlice: (input) => {
              landInput = input;
            },
            onReview: (input) => {
              reviewWorktree = input.worktree;
            },
          }),
        ),
      );
      assert.equal(snapshot.goals.find((g) => g.title === "WF land")?.status, "completed");
      // Verify + land ran against the LEAF peer's worktree/branch, not the run record.
      assert.equal(landInput?.sliceBranch, "codex-peer/leaf-7");
      assert.equal(reviewWorktree, "/tmp/source-repo/.worktrees/leaf-7");
    }).pipe(Effect.provide(NodeServices.layer));
  });
});

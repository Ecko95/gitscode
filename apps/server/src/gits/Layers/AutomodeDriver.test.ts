import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  DelamainPeer,
  DelamainPeerListResult,
  GitsReviewResult,
  PeerStatus,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import {
  AutomodeSupervisor,
  type AutomodeSupervisorShape,
} from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeDriver } from "../Services/AutomodeDriver.ts";
import { GitsReviewPipeline } from "../Services/GitsReviewPipeline.ts";
import { AutomodeLanding, type AutomodeLandResult } from "../Services/AutomodeLanding.ts";
import { AutomodeHeldPr, type AutomodeOpenHeldPrResult } from "../Services/AutomodeHeldPr.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";
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
  readonly review?: GitsReviewResult;
  readonly landResult?: AutomodeLandResult;
  readonly openResult?: AutomodeOpenHeldPrResult;
  readonly onOpenHeldPr?: () => void;
  readonly mergeResults?: boolean[];
}

// Mutable holder so a test can change what listPeers returns between ticks.
function makeLayer(peerStatus: { current: PeerStatus | "absent" }, options?: MakeLayerOptions) {
  const spawnedPeerId = basePeer.id;
  const delamain = Layer.mock(DelamainAdapter)({
    listPeers: () =>
      Effect.succeed({
        ...emptyList,
        peers:
          peerStatus.current === "absent"
            ? []
            : [{ ...basePeer, status: peerStatus.current, rawStatus: peerStatus.current }],
      }),
    spawnPeer: (input) =>
      Effect.succeed({
        ...basePeer,
        id: spawnedPeerId,
        name: input.name ?? basePeer.name,
        model: input.model ?? basePeer.model,
        sourceRepo: input.repo,
        task: input.prompt,
        status: "running",
        rawStatus: "running",
      }),
    killPeer: () => Effect.succeed({ ...basePeer, status: "killed", rawStatus: "killed" }),
  });
  const usage = Layer.mock(AutomodeUsageMeter)({
    readBudgetUsage: () =>
      Effect.succeed({
        source: "unavailable",
        totalCostUsd: null,
        totalProcessedTokens: null,
        updatedAt: null,
        note: "n/a",
      }),
  });
  const reviewPipeline = Layer.mock(GitsReviewPipeline)({
    review: () => Effect.succeed(options?.review ?? passingReview),
  });
  const landing = Layer.mock(AutomodeLanding)({
    land_slice: () => Effect.succeed(options?.landResult ?? { status: "landed" }),
  });
  const mergeQueue = [...(options?.mergeResults ?? [])];
  const heldPr = Layer.mock(AutomodeHeldPr)({
    open_held_pr: () =>
      Effect.sync(() => {
        options?.onOpenHeldPr?.();
        return (
          options?.openResult ?? {
            status: "opened",
            url: "https://github.com/o/r/pull/30",
            number: 30,
          }
        );
      }),
    detect_merge: () => Effect.succeed({ merged: mergeQueue.shift() ?? false }),
  });
  const config = ServerConfig.layerTest(process.cwd(), {
    prefix: "gits-automode-driver-test-",
  }).pipe(Layer.provide(NodeServices.layer));
  const supervisor = AutomodeSupervisorLive.pipe(
    Layer.provide(delamain),
    Layer.provide(usage),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  return AutomodeDriverLive.pipe(
    Layer.provideMerge(supervisor),
    Layer.provide(delamain),
    Layer.provide(reviewPipeline),
    Layer.provide(landing),
    Layer.provide(heldPr),
  );
}

function armAutonomous(supervisor: AutomodeSupervisorShape) {
  return supervisor.updatePolicy({
    mode: "autonomous",
    killSwitchEnabled: false,
    maxActivePeers: 1,
    allowedRepos: ["/tmp/source-repo"],
    integrationBranch: "auto/gits-self",
    verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
    requireApprovalForPeerSpawn: false,
    requireApprovalBeforeIntegrate: false,
    requireApprovalBeforeDestructiveAction: false,
  });
}

describe("AutomodeDriver", () => {
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

  it.effect("on done: empty verificationCommands → halts (fail-closed)", () => {
    const peerStatus = { current: "absent" as PeerStatus | "absent" };
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      const driver = yield* AutomodeDriver;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        allowedRepos: ["/tmp/source-repo"],
        integrationBranch: "auto/gits-self",
        verificationCommands: [],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
      });
      yield* supervisor.enqueueGoal({ title: "Unverified", repo: "/tmp/source-repo", prompt: "x" });

      yield* driver.tickOnce(); // dispatch
      peerStatus.current = "done";
      yield* driver.tickOnce(); // no verify commands → halt

      const snapshot = yield* supervisor.getSnapshot();
      assert.notEqual(snapshot.goals.find((g) => g.title === "Unverified")?.status, "completed");
      assert.equal(snapshot.driverHalted, true);
    }).pipe(Effect.provide(makeLayer(peerStatus)));
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
});

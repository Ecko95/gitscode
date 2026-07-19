import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type {
  AutomodeBudgetUsage,
  DelamainPeerListResult,
  HermesExecutionDraft,
  HermesProposalCard,
} from "@t3tools/contracts";
import { HermesAdapterError } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { AutomodeProposalSweep } from "../Services/AutomodeProposalSweep.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { HermesAdapter } from "../Services/HermesAdapter.ts";
import { AutomodeProposalSweepLive } from "./AutomodeProposalSweep.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";

const REPO = "/tmp/sweep-repo";
const OTHER_REPO = "/tmp/sweep-repo-2";
const EVENING = Date.UTC(2026, 0, 7, 20, 0); // 20:00 London (UTC+0 in January).
const NEXT_EVENING = Date.UTC(2026, 0, 8, 20, 0);
const AFTERNOON = Date.UTC(2026, 0, 7, 15, 0); // before the 20:00 dinner window.

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

const availableBudgetUsage: AutomodeBudgetUsage = {
  source: "provider-runtime",
  totalCostUsd: 0,
  totalProcessedTokens: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  note: null,
};

function makeCard(overrides: Partial<HermesProposalCard>): HermesProposalCard {
  return {
    id: "proposal-sweep",
    episodeId: "epi-sweep",
    title: "Improve sweep repo",
    summary: "Summary.",
    detail: "Detail.",
    evidence: ["evidence"],
    scope: ["apps/server"],
    risk: "low",
    actionKind: "worktree-spawn",
    status: "proposed",
    requiresApproval: true,
    recommendedExecutor: "delamain",
    verificationPlan: ["bun run test"],
    nextCommandOrPrompt: "Do the thing.",
    blockedReason: null,
    source: "test",
    projectDir: REPO,
    decisionReason: null,
    decidedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDraft(overrides: Partial<HermesExecutionDraft>): HermesExecutionDraft {
  return {
    id: "draft-sweep",
    proposalId: "proposal-sweep",
    kind: "delamain-peer",
    status: "draft",
    title: "Improve sweep repo",
    repo: REPO,
    sourceBranch: "main",
    targetBranch: "main",
    prompt: "Do the thing.",
    risk: "low",
    fileOwnership: ["apps/server"],
    verificationCommands: ["bun run test"],
    blockedReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface HermesOptions {
  readonly inspect?: (projectDir: string) => Effect.Effect<HermesProposalCard, HermesAdapterError>;
  readonly draft?: HermesExecutionDraft;
  readonly onInspect?: (projectDir: string) => void;
}

function makeLayer(hermesOptions: HermesOptions = {}) {
  const supervisor = AutomodeSupervisorLive.pipe(
    Layer.provide(
      Layer.mock(DelamainAdapter)({
        listPeers: () => Effect.succeed(emptyPeerList),
        killPeer: () => Effect.succeed(emptyPeerList.peers[0] as never),
      }),
    ),
    Layer.provide(Layer.mock(AutomodeLanding)({ ensure_integration_branch: () => Effect.void })),
    Layer.provide(
      Layer.mock(AutomodeUsageMeter)({
        readBudgetUsage: () => Effect.succeed(availableBudgetUsage),
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "gits-sweep-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  // Real inspectGitsAndPropose mints a fresh episodeId per proposal; mirror that so the
  // cross-night dedup guard sees distinct episodes.
  let proposalSeq = 0;
  const hermes = Layer.mock(HermesAdapter)({
    inspectGitsAndPropose: ({ projectDir }) => {
      hermesOptions.onInspect?.(projectDir);
      proposalSeq += 1;
      return hermesOptions.inspect === undefined
        ? Effect.succeed(
            makeCard({
              projectDir,
              id: `proposal-${proposalSeq}`,
              episodeId: `epi-${proposalSeq}`,
            }),
          )
        : hermesOptions.inspect(projectDir);
    },
    decideProposal: () => Effect.succeed(makeCard({ status: "approved" })),
    draftFromProposal: () => Effect.succeed(hermesOptions.draft ?? makeDraft({})),
  });
  return AutomodeProposalSweepLive.pipe(
    Layer.provideMerge(supervisor),
    Layer.provide(hermes),
    Layer.provideMerge(TestClock.layer()),
  );
}

function arm(options?: {
  readonly nightlyProposalSweep?: boolean;
  readonly proposalRepos?: string[];
}) {
  return Effect.gen(function* () {
    const supervisor = yield* AutomodeSupervisor;
    yield* supervisor.updatePolicy({
      mode: "autonomous",
      killSwitchEnabled: false,
      requireApprovalForPeerSpawn: false,
      maxBudgetUsd: 25,
      allowedRepos: [REPO, OTHER_REPO],
      nightlyProposalSweep: options?.nightlyProposalSweep ?? true,
      proposalRepos: options?.proposalRepos ?? [REPO],
    });
    return supervisor;
  });
}

describe("AutomodeProposalSweep", () => {
  it.effect("enqueues one waiting-approval goal per opted-in repo, once per night", () => {
    let inspects = 0;
    return Effect.gen(function* () {
      const supervisor = yield* arm();
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(EVENING);
      yield* sweep.tick();
      yield* sweep.tick(); // second tick same night is a no-op.

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.length, 1);
      assert.equal(snapshot.goals[0]!.repo, REPO);
      // Enqueued exactly like the approve bridge (status "queued", not auto-approved): the
      // driver's dispatch gate flips it to waiting-approval, which the Telegram APPROVE verb
      // clears. approvedAt stays null — nothing was approved on the operator's behalf.
      assert.equal(snapshot.goals[0]!.status, "queued");
      assert.isNull(snapshot.goals[0]!.approvedAt);
      // Threads the card's episode id onto the goal (decision 23).
      assert.equal(snapshot.goals[0]!.episodeId, "epi-1");
      assert.equal(inspects, 1);

      // Next night, the goal from night 1 is still live (queued, operator away): the repo is
      // deduped BEFORE hermes runs, so no second goal and no wasted codex invocation.
      yield* TestClock.setTime(NEXT_EVENING);
      yield* sweep.tick();
      assert.equal(inspects, 1);
      assert.equal((yield* supervisor.getSnapshot()).goals.length, 1);
    }).pipe(Effect.provide(makeLayer({ onInspect: () => (inspects += 1) })));
  });

  it.effect("re-sweeps a repo once its prior goal reaches a terminal state", () => {
    let inspects = 0;
    return Effect.gen(function* () {
      const supervisor = yield* arm();
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(EVENING);
      yield* sweep.tick();
      const first = (yield* supervisor.getSnapshot()).goals[0]!;
      // Drive the night-1 goal terminal, freeing the repo for a fresh sweep.
      yield* supervisor.rejectGoal({ goalId: first.id });

      yield* TestClock.setTime(NEXT_EVENING);
      yield* sweep.tick();
      assert.equal(inspects, 2);
      const live = (yield* supervisor.getSnapshot()).goals.filter(
        (goal) => goal.status !== "rejected",
      );
      assert.equal(live.length, 1);
    }).pipe(Effect.provide(makeLayer({ onInspect: () => (inspects += 1) })));
  });

  it.effect("does nothing before the dinner window", () => {
    let inspects = 0;
    return Effect.gen(function* () {
      const supervisor = yield* arm();
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(AFTERNOON);
      yield* sweep.tick();
      assert.equal(inspects, 0);
      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
    }).pipe(Effect.provide(makeLayer({ onInspect: () => (inspects += 1) })));
  });

  it.effect("is a no-op when the sweep flag is off", () => {
    let inspects = 0;
    return Effect.gen(function* () {
      const supervisor = yield* arm({ nightlyProposalSweep: false });
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(EVENING);
      yield* sweep.tick();
      assert.equal(inspects, 0);
      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
    }).pipe(Effect.provide(makeLayer({ onInspect: () => (inspects += 1) })));
  });

  it.effect("skips a blocked card without enqueueing", () => {
    return Effect.gen(function* () {
      const supervisor = yield* arm();
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(EVENING);
      yield* sweep.tick();
      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          inspect: (projectDir) =>
            Effect.succeed(makeCard({ projectDir, status: "blocked", blockedReason: "preflight" })),
        }),
      ),
    );
  });

  it.effect("isolates a per-repo failure so other repos still sweep", () => {
    return Effect.gen(function* () {
      const supervisor = yield* arm({ proposalRepos: [REPO, OTHER_REPO] });
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(EVENING);
      yield* sweep.tick();

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.length, 1);
      assert.equal(snapshot.goals[0]!.repo, OTHER_REPO);
    }).pipe(
      Effect.provide(
        makeLayer({
          inspect: (projectDir) =>
            projectDir === REPO
              ? Effect.fail(new HermesAdapterError({ message: "codex busy" }))
              : Effect.succeed(
                  makeCard({ id: "p2", episodeId: "epi-2", projectDir, title: "Other" }),
                ),
          draft: makeDraft({ repo: OTHER_REPO, title: "Other" }),
        }),
      ),
    );
  });

  it.effect("skips a proposalRepo that is not in allowedRepos", () => {
    let inspects = 0;
    return Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxBudgetUsd: 25,
        allowedRepos: [REPO], // OTHER_REPO deliberately absent.
        nightlyProposalSweep: true,
        proposalRepos: [OTHER_REPO],
      });
      const sweep = yield* AutomodeProposalSweep;
      yield* TestClock.setTime(EVENING);
      yield* sweep.tick();
      assert.equal(inspects, 0);
      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
    }).pipe(Effect.provide(makeLayer({ onInspect: () => (inspects += 1) })));
  });
});

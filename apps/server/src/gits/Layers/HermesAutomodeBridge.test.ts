import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  AutomodeBudgetUsage,
  DelamainPeer,
  DelamainPeerListResult,
  HermesExecutionDraft,
  HermesProposalCard,
  HermesProposalStatus,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import type { CockpitInboxRecordInput } from "../Services/CockpitInbox.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";
import { AutomodeSupervisorTestRoutingLayer } from "./AutomodeSupervisor.testHelpers.ts";
import { decideProposalWithAutomodeBridge } from "./HermesAutomodeBridge.ts";

const peer: DelamainPeer = {
  id: "peer-bridge",
  name: "Bridge Peer",
  engine: "codex",
  model: "gpt-5.5",
  status: "running",
  rawStatus: "running",
  integrationStatus: null,
  sourceRepo: "/tmp/source-repo",
  worktreePath: "/tmp/source-repo/.worktrees/peer-bridge",
  branch: "codex-peer/peer-bridge",
  baseBranch: "main",
  mergeBranch: "main",
  prUrl: null,
  task: "Bridge task",
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

// Cost telemetry present and well under budget — lets autonomous dispatch proceed.
const availableBudgetUsage: AutomodeBudgetUsage = {
  source: "provider-runtime",
  totalCostUsd: 0,
  totalProcessedTokens: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  note: null,
};

function makeSupervisorLayer(options?: { readonly onSpawn?: () => void }) {
  return AutomodeSupervisorLive.pipe(
    Layer.provide(AutomodeSupervisorTestRoutingLayer),
    Layer.provide(
      Layer.mock(DelamainAdapter)({
        listPeers: () => Effect.succeed(emptyPeerList),
        spawnPeer: (input) =>
          Effect.sync(() => {
            options?.onSpawn?.();
            return { ...peer, sourceRepo: input.repo, task: input.prompt };
          }),
        killPeer: () => Effect.succeed(peer),
      }),
    ),
    Layer.provide(
      Layer.mock(AutomodeLanding)({
        ensure_integration_branch: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(AutomodeUsageMeter)({
        readBudgetUsage: () => Effect.succeed(availableBudgetUsage),
      }),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "gits-hermes-automode-bridge-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

function makeProposal(status: HermesProposalStatus): HermesProposalCard {
  return {
    id: "proposal-1",
    episodeId: "epi-proposal-1",
    title: "Fix flaky retry test",
    summary: "Retry test is flaky.",
    detail: "Deflake the retry test in the server package.",
    evidence: ["3 failures in the last 5 CI runs"],
    scope: ["apps/server"],
    risk: "low",
    actionKind: "repo-write",
    status,
    requiresApproval: true,
    recommendedExecutor: "delamain",
    verificationPlan: ["vitest run src/gits/Layers/"],
    nextCommandOrPrompt: "Deflake the retry test.",
    blockedReason: null,
    source: "test",
    projectDir: "/tmp/source-repo",
    model: "gpt-5.6-sol",
    notBefore: "2026-01-02T00:00:00.000Z",
    maxRuntimeMinutes: 45,
    verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
    integrationBranch: "auto/proposal-1",
    sourceThreadId: "thread-1",
    decisionReason: null,
    decidedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const defaultDraft: HermesExecutionDraft = {
  id: "draft-1",
  proposalId: "proposal-1",
  kind: "delamain-peer",
  status: "draft",
  title: "Fix flaky retry test",
  repo: "/tmp/source-repo",
  sourceBranch: "main",
  targetBranch: "main",
  prompt: "Deflake the retry test.",
  risk: "low",
  fileOwnership: ["apps/server"],
  verificationCommands: ["vitest run src/gits/Layers/"],
  blockedReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

// Stateful fake mirroring HermesCliAdapter semantics: listProposals reflects the
// current status, decideProposal persists the decision, draftFromProposal is canned.
function makeFakeHermes(options?: {
  readonly initialStatus?: HermesProposalStatus;
  readonly draft?: HermesExecutionDraft;
  readonly proposal?: Partial<HermesProposalCard>;
}) {
  let proposal = {
    ...makeProposal(options?.initialStatus ?? "proposed"),
    ...options?.proposal,
  };
  let draftCalls = 0;
  return {
    hermes: {
      listProposals: () =>
        Effect.succeed({ proposals: [proposal], checkedAt: "2026-01-01T00:00:00.000Z" }),
      decideProposal: (input: { proposalId: string; decision: string }) =>
        Effect.sync(() => {
          proposal = {
            ...proposal,
            status: input.decision === "approve" ? ("approved" as const) : ("rejected" as const),
          };
          return proposal;
        }),
      draftFromProposal: () =>
        Effect.sync(() => {
          draftCalls += 1;
          return options?.draft ?? defaultDraft;
        }),
    },
    draftCallCount: () => draftCalls,
  };
}

const armAutonomous = Effect.gen(function* () {
  const supervisor = yield* AutomodeSupervisor;
  yield* supervisor.updatePolicy({
    mode: "autonomous",
    killSwitchEnabled: false,
    requireApprovalForPeerSpawn: false,
    maxRuntimeMinutes: null,
    maxBudgetUsd: 25,
    allowedRepos: ["/tmp/source-repo"],
    autoEnqueueApprovedProposals: true,
  });
  return supervisor;
});

describe("decideProposalWithAutomodeBridge", () => {
  it.effect("approval queues once, arms for eligibility, and records the durable transition", () =>
    Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      const { hermes } = makeFakeHermes({ proposal: { notBefore: null } });
      const scheduled: Array<string | null> = [];
      const events: CockpitInboxRecordInput[] = [];
      const dependencies = {
        scheduler: {
          scheduleApprovedGoal: ({ eligibleAt }: { readonly eligibleAt: string | null }) =>
            Effect.sync(() => {
              scheduled.push(eligibleAt);
              return {} as never;
            }),
        },
        inbox: {
          record: (input: CockpitInboxRecordInput) =>
            Effect.sync(() => {
              events.push(input);
              return {} as never;
            }),
        },
      };

      yield* decideProposalWithAutomodeBridge(
        hermes,
        supervisor,
        { proposalId: "proposal-1", decision: "approve" },
        dependencies,
      );
      yield* decideProposalWithAutomodeBridge(
        hermes,
        supervisor,
        { proposalId: "proposal-1", decision: "approve" },
        dependencies,
      );

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 1);
      assert.deepEqual(scheduled, [null, null]);
      assert.deepEqual(
        events.map(({ eventKey, state, goalId }) => ({ eventKey, state, goalId })),
        [
          {
            eventKey: "proposal:proposal-1:approve",
            state: "approved-queued",
            goalId: events[0]!.goalId,
          },
          {
            eventKey: `goal:${events[0]!.goalId}:scheduled`,
            state: "scheduled-tonight",
            goalId: events[0]!.goalId,
          },
          {
            eventKey: "proposal:proposal-1:approve",
            state: "approved-queued",
            goalId: events[0]!.goalId,
          },
          {
            eventKey: `goal:${events[0]!.goalId}:scheduled`,
            state: "scheduled-tonight",
            goalId: events[0]!.goalId,
          },
        ],
      );
      assert.isNotNull(events[0]!.goalId);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("approve with flag on + autonomous enqueues a goal that dispatch can run", () => {
    let spawnCount = 0;
    return Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      const { hermes } = makeFakeHermes();

      const decided = yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
      });
      assert.equal(decided.status, "approved");

      const snapshot = yield* supervisor.getSnapshot();
      assert.equal(snapshot.goals.length, 1);
      assert.equal(snapshot.goals[0]!.title, "Fix flaky retry test");
      assert.equal(snapshot.goals[0]!.repo, "/tmp/source-repo");
      assert.equal(snapshot.goals[0]!.status, "queued");
      // Episode thread (decision 23): the goal carries the proposal's episodeId.
      assert.equal(snapshot.goals[0]!.episodeId, "epi-proposal-1");
      assert.equal(snapshot.goals[0]!.model, "gpt-5.6-sol");
      assert.equal(snapshot.goals[0]!.notBefore, "2026-01-02T00:00:00.000Z");
      assert.equal(snapshot.goals[0]!.maxRuntimeMinutes, 45);
      assert.equal(snapshot.goals[0]!.verificationCommands.length, 1);
      assert.equal(snapshot.goals[0]!.integrationBranch, "auto/proposal-1");

      const dispatched = yield* supervisor.dispatchGoal({ goalId: snapshot.goals[0]!.id });
      assert.equal(dispatched.goal.status, "running");
      assert.equal(spawnCount, 1);
    }).pipe(
      Effect.provide(
        makeSupervisorLayer({
          onSpawn: () => {
            spawnCount += 1;
          },
        }),
      ),
    );
  });

  it.effect("approve queues even when the legacy auto-enqueue flag is off", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        maxBudgetUsd: 25,
        allowedRepos: ["/tmp/source-repo"],
      });
      const { hermes, draftCallCount } = makeFakeHermes();

      yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
      });

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 1);
      assert.equal(draftCallCount(), 1);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("approve queues in manual mode without dispatching", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        autoEnqueueApprovedProposals: true,
        allowedRepos: ["/tmp/source-repo"],
      });
      const { hermes, draftCallCount } = makeFakeHermes();

      yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
      });

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 1);
      assert.equal(draftCallCount(), 1);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("re-approving an already approved proposal does not enqueue a duplicate", () =>
    Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      const { hermes } = makeFakeHermes();

      yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
      });
      yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
      });

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 1);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("does not double-enqueue a card the sweep already enqueued (episode dedup)", () =>
    Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      // Simulate the nightly sweep having already enqueued this proposal's episode.
      yield* supervisor.enqueueGoal({
        title: "Fix flaky retry test",
        prompt: "Deflake the retry test.",
        repo: "/tmp/source-repo",
        episodeId: "epi-proposal-1",
      });
      const { hermes, draftCallCount } = makeFakeHermes({ initialStatus: "proposed" });

      // A cockpit approve of the same (still-"proposed") card must not add a second goal.
      yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
      });

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 1);
      assert.equal(draftCallCount(), 0);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("reject never enqueues", () =>
    Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      const { hermes, draftCallCount } = makeFakeHermes();

      yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "reject",
      });

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
      assert.equal(draftCallCount(), 0);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("rejects edited repositories outside Automode policy before persisting approval", () =>
    Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      const { hermes } = makeFakeHermes();
      const error = yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
        proposalId: "proposal-1",
        decision: "approve",
        projectDir: "/tmp/not-allowed",
      }).pipe(Effect.flip);

      assert.include(error.message, "not allowed");
      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );

  it.effect("open-gsd, verification, and blocked drafts are never enqueued", () =>
    Effect.gen(function* () {
      const supervisor = yield* armAutonomous;
      const variants: ReadonlyArray<HermesExecutionDraft> = [
        { ...defaultDraft, kind: "open-gsd" },
        { ...defaultDraft, kind: "verification" },
        { ...defaultDraft, status: "blocked", blockedReason: "Blocked by policy." },
        { ...defaultDraft, repo: null },
      ];
      for (const draft of variants) {
        const { hermes } = makeFakeHermes({ draft });
        yield* decideProposalWithAutomodeBridge(hermes, supervisor, {
          proposalId: "proposal-1",
          decision: "approve",
        });
      }

      assert.equal((yield* supervisor.getSnapshot()).goals.length, 0);
    }).pipe(Effect.provide(makeSupervisorLayer())),
  );
});

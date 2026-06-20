# Autonomous Toggle — Plan 1: AutomodeDriver Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a server-side background driver that, in `mode:"autonomous"`, advances a single repo's queued automode goals **one peer at a time** — dispatching the next goal, observing the spawned peer's outcome, transitioning the goal to `completed`/`failed`, and halting the chain on failure or a waiting peer — entirely against the existing (mockable) `DelamainAdapter`.

**Architecture:** A new `AutomodeDriver` Effect layer forks a scoped polling fiber (`Effect.forever` + `Effect.sleep`, the `ProcessResourceMonitor`/`ProviderSessionReaper` pattern) that calls a deterministic `tickOnce()`. `tickOnce()` reads the supervisor snapshot, reconciles the in-flight goal against its peer's `PeerStatus`, and — if idle and not halted — dispatches the oldest `queued` goal. The supervisor gains the missing terminal-state transitions (`completeGoal`/`failGoal`) and an explicit persisted halt flag (`haltDriver`/`resumeDriver`) so halt-on-fail survives restarts. `tickOnce()` is exposed on the service so tests step the loop deterministically instead of waiting on the timer.

**Tech Stack:** TypeScript, Effect (Layer/Effect/Ref/Schedule/Schema), `@t3tools/contracts` (effect Schema), `@effect/vitest` (`it.effect`, `Layer.mock`), `@effect/platform-node` (`NodeServices`), vitest runner. RTK prefix for commands.

**Scope — this plan is the spine only.** It deliberately excludes (each is its own later plan):
- **Plan 2 — Confined-yolo spawn (H0b):** modify `delamain` + pass `gits-confine.sh --profile peer` + `sandbox/yolo` spawn args. (This plan dispatches via the *existing* `spawnPeer` args.)
- **Plan 3 — Held-PR pipeline:** integration branch, slice→integration landing, `GitsReviewPipeline` gate, held PR → `gits`, patch-id merge detection.
- **Plan 4 — Episode ledger (SQLite):** verifier-output summaries, Motoko rehydrate.
- **Plan 5 — Telegram notifier:** the `waiting`/`failed`/`done` events this plan currently only `logInfo`s become Telegram messages on the existing bot channel.
- **Plan 6 — Tiered peer-question auto-answer** (type-gate + mini→`gpt-5.5`).
- **Plan 7 — Motoko dispatch + context-gate** (proposal→goal standing-approval, grill) and **per-project session-state keying**.
- **Plan 8 — Cockpit arm/kill/resume UI.**

Source of truth for the whole design: `docs/brainstorms/autonomous-toggle.md`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/contracts/src/gits.ts` | Automode schemas. Add `driverHalted`/`driverHaltedReason` to `AutomodeSnapshot`; add `AutomodeGoalOutcomeInput`, `AutomodeDriverHaltInput`. | Modify |
| `apps/server/src/gits/Services/AutomodeSupervisor.ts` | Supervisor service interface. Add `completeGoal`/`failGoal`/`haltDriver`/`resumeDriver`. | Modify |
| `apps/server/src/gits/Layers/AutomodeSupervisor.ts` | Supervisor impl. Add halt fields to state + persisted schema; implement the 4 new methods; surface halt in `makeSnapshot`. | Modify |
| `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts` | Supervisor tests. Add cases for the 4 new methods + persistence of the halt flag. | Modify |
| `apps/server/src/gits/Services/AutomodeDriver.ts` | New `AutomodeDriver` service tag + shape (`tickOnce`). | Create |
| `apps/server/src/gits/Layers/AutomodeDriver.ts` | New driver layer: `tickOnce()` reconcile+dispatch logic + scoped forked tick fiber. | Create |
| `apps/server/src/gits/Layers/AutomodeDriver.test.ts` | Driver tests: dispatch next queued, reconcile done→completed, failed→failed+halt, waiting→halt, sequential, respects kill switch/mode/halt. | Create |
| `apps/server/src/server.ts` | Layer wiring. Build `AutomodeDriverLayerLive`, merge into `GitsLayerLive`. | Modify |

---

## Task 1: Contracts — snapshot halt fields + driver input types

**Files:**
- Modify: `packages/contracts/src/gits.ts` (Automode block ~543–656)

- [ ] **Step 1: Add the two new input schemas + extend the snapshot**

In `packages/contracts/src/gits.ts`, locate `AutomodeSnapshot` (currently lines ~604–613) and add two fields **before** `updatedAt`:

```typescript
export const AutomodeSnapshot = Schema.Struct({
  policy: AutomodePolicy,
  budgetUsage: AutomodeBudgetUsage,
  goals: Schema.Array(AutomodeGoal),
  activePeerCount: NonNegativeInt,
  pendingApprovalCount: NonNegativeInt,
  driverHalted: Schema.Boolean,
  driverHaltedReason: Schema.NullOr(SummaryString),
  lastEvent: Schema.NullOr(SummaryString),
  updatedAt: IsoDateTime,
});
export type AutomodeSnapshot = typeof AutomodeSnapshot.Type;
```

Then, immediately after `AutomodeRejectGoalInput` (currently ends ~line 647), add:

```typescript
export const AutomodeGoalOutcomeInput = Schema.Struct({
  goalId: TrimmedNonEmptyString,
  reason: Schema.optional(SummaryString),
});
export type AutomodeGoalOutcomeInput = typeof AutomodeGoalOutcomeInput.Type;

export const AutomodeDriverHaltInput = Schema.Struct({
  reason: SummaryString,
});
export type AutomodeDriverHaltInput = typeof AutomodeDriverHaltInput.Type;
```

- [ ] **Step 2: Typecheck the contracts package**

Run: `cd /home/joshua/dev/projects/gitscode && rtk tsc -p packages/contracts/tsconfig.json --noEmit`
Expected: PASS (no errors). The new symbols are exported from the package barrel automatically since `gits.ts` is re-exported.

- [ ] **Step 3: Commit**

```bash
rtk git add packages/contracts/src/gits.ts
rtk git commit -m "feat(contracts): automode snapshot halt fields + driver outcome/halt inputs"
```

---

## Task 2: Supervisor — terminal-state transitions + persisted halt flag

**Files:**
- Modify: `apps/server/src/gits/Services/AutomodeSupervisor.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts`
- Test: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`

- [ ] **Step 1: Extend the service interface**

In `apps/server/src/gits/Services/AutomodeSupervisor.ts`, add the imports and four methods. The import block (lines 4–13) gains `AutomodeGoalOutcomeInput` and `AutomodeDriverHaltInput`:

```typescript
import type {
  AutomodeDispatchResult,
  AutomodeDriverHaltInput,
  AutomodeEnqueueGoalInput,
  AutomodeGoal,
  AutomodeGoalInput,
  AutomodeGoalOutcomeInput,
  AutomodePolicyUpdateInput,
  AutomodeRejectGoalInput,
  AutomodeSnapshot,
  AutomodeSupervisorError,
} from "@t3tools/contracts";
```

Add to `AutomodeSupervisorShape` (after `dispatchGoal`, before the closing brace):

```typescript
  readonly completeGoal: (
    input: AutomodeGoalInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly failGoal: (
    input: AutomodeGoalOutcomeInput,
  ) => Effect.Effect<AutomodeGoal, AutomodeSupervisorError>;
  readonly haltDriver: (
    input: AutomodeDriverHaltInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly resumeDriver: () => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
```

- [ ] **Step 2: Write the failing supervisor tests**

In `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`, add these cases inside the existing `describe` block (the harness `makeLayer` already exists). They rely only on the existing mock:

```typescript
  it.effect("completeGoal transitions a running goal to completed", () =>
    Effect.gen(function* () {
      const supervisor = yield* AutomodeSupervisor;
      yield* supervisor.updatePolicy({
        mode: "autonomous",
        killSwitchEnabled: false,
        allowedRepos: ["/tmp/source-repo"],
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
    }).pipe(Effect.provide(makeLayer())),
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
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk vitest run src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: FAIL — `completeGoal`/`failGoal`/`haltDriver`/`resumeDriver` are not functions / `driverHalted` is `undefined`.

- [ ] **Step 4: Add halt fields to the internal state + persisted schema**

In `apps/server/src/gits/Layers/AutomodeSupervisor.ts`, extend the `AutomodeState` interface (currently lines 39–44):

```typescript
interface AutomodeState {
  readonly policy: AutomodePolicy;
  readonly goals: ReadonlyArray<AutomodeGoal>;
  readonly driverHalted: boolean;
  readonly driverHaltedReason: string | null;
  readonly lastEvent: string | null;
  readonly updatedAt: string;
}
```

Extend `PersistedAutomodeState` (currently lines 51–57) with **optional** fields so old state files still parse:

```typescript
const PersistedAutomodeState = Schema.Struct({
  version: Schema.Literal(1),
  policy: AutomodePolicySchema,
  goals: Schema.Array(AutomodeGoalSchema),
  driverHalted: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  driverHaltedReason: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  lastEvent: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
```

Update `toPersistedAutomodeState` (lines 87–95) and `fromPersistedAutomodeState` (lines 97–104) to carry the fields:

```typescript
function toPersistedAutomodeState(state: AutomodeState): PersistedAutomodeState {
  return {
    version: 1,
    policy: state.policy,
    goals: [...state.goals],
    driverHalted: state.driverHalted,
    driverHaltedReason: state.driverHaltedReason,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}

function fromPersistedAutomodeState(state: PersistedAutomodeState): AutomodeState {
  return {
    policy: state.policy,
    goals: state.goals,
    driverHalted: state.driverHalted,
    driverHaltedReason: state.driverHaltedReason,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}
```

Update the `initialState` fallback in the layer body (currently lines 299–304) to include the new fields:

```typescript
    const initialState = yield* loadAutomodeState(statePath, {
      policy: defaultPolicy(initializedAt),
      goals: [],
      driverHalted: false,
      driverHaltedReason: null,
      lastEvent: "Automode initialized with kill switch enabled.",
      updatedAt: initializedAt,
    });
```

- [ ] **Step 5: Surface halt in `makeSnapshot`**

Update `makeSnapshot` (currently lines 248–262) to pass the halt fields through:

```typescript
function makeSnapshot(
  state: AutomodeState,
  activePeers: number,
  budgetUsage: AutomodeBudgetUsage,
): AutomodeSnapshot {
  return {
    policy: state.policy,
    budgetUsage,
    goals: sortGoals(state.goals),
    activePeerCount: activePeers,
    pendingApprovalCount: pendingApprovalCount(state.goals),
    driverHalted: state.driverHalted,
    driverHaltedReason: state.driverHaltedReason,
    lastEvent: state.lastEvent,
    updatedAt: state.updatedAt,
  };
}
```

- [ ] **Step 6: Implement the four methods**

In the `supervisor` object literal (after `dispatchGoal`, before the closing `}` at line 603), add. These follow the existing `approveGoal`/`rejectGoal` shape (`commitState` + `updateGoal` + `nowIso`):

```typescript
      completeGoal: (input) =>
        Effect.gen(function* () {
          const completedAt = yield* nowIso;
          const nextState = yield* commitState((state) => {
            const goal = findGoal(state, input.goalId);
            if (goal === null) {
              return state;
            }
            return updateGoal(
              { ...state, lastEvent: `Completed ${goal.title}.`, updatedAt: completedAt },
              input.goalId,
              (existing) => ({
                ...existing,
                status: "completed",
                blockedReason: null,
                updatedAt: completedAt,
              }),
            );
          });
          const goal = findGoal(nextState, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }
          return goal;
        }),
      failGoal: (input) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          const reason = input.reason ?? "Peer ended in a failure state.";
          const nextState = yield* commitState((state) => {
            const goal = findGoal(state, input.goalId);
            if (goal === null) {
              return state;
            }
            return updateGoal(
              { ...state, lastEvent: `Failed ${goal.title}.`, updatedAt: failedAt },
              input.goalId,
              (existing) => ({
                ...existing,
                status: "failed",
                blockedReason: reason,
                updatedAt: failedAt,
              }),
            );
          });
          const goal = findGoal(nextState, input.goalId);
          if (goal === null) {
            return yield* toAutomodeError(`Automode goal ${input.goalId} was not found.`);
          }
          return goal;
        }),
      haltDriver: (input) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            driverHalted: true,
            driverHaltedReason: input.reason,
            lastEvent: input.reason,
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      resumeDriver: () =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            driverHalted: false,
            driverHaltedReason: null,
            lastEvent: "Driver resumed by operator.",
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
```

- [ ] **Step 7: Run the supervisor tests to verify they pass**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk vitest run src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: PASS (all existing + 3 new cases).

- [ ] **Step 8: Commit**

```bash
rtk git add apps/server/src/gits/Services/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts
rtk git commit -m "feat(automode): goal complete/fail transitions + persisted driver halt/resume"
```

---

## Task 3: AutomodeDriver service tag

**Files:**
- Create: `apps/server/src/gits/Services/AutomodeDriver.ts`

- [ ] **Step 1: Create the service**

```typescript
import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type { AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeDriverShape {
  /**
   * Run exactly one driver step: reconcile the in-flight goal against its peer,
   * and if idle (and autonomous, not killed, not halted) dispatch the next queued
   * goal. Exposed so tests can step the loop deterministically.
   */
  readonly tickOnce: () => Effect.Effect<void, AutomodeSupervisorError>;
}

export class AutomodeDriver extends Context.Service<AutomodeDriver, AutomodeDriverShape>()(
  "t3/gits/Services/AutomodeDriver",
) {}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
rtk git add apps/server/src/gits/Services/AutomodeDriver.ts
rtk git commit -m "feat(automode): AutomodeDriver service tag"
```

---

## Task 4: AutomodeDriver layer — tick loop

**Files:**
- Create: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Test: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`

- [ ] **Step 1: Write the failing driver tests**

Create `apps/server/src/gits/Layers/AutomodeDriver.test.ts`. The harness mirrors `AutomodeSupervisor.test.ts`: provide the real `AutomodeSupervisorLive` (so `tickOnce` exercises real state transitions) plus a `Layer.mock(DelamainAdapter)` whose `listPeers` returns a configurable peer, then build `AutomodeDriverLive` on top.

```typescript
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DelamainPeer, DelamainPeerListResult, PeerStatus } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeDriver } from "../Services/AutomodeDriver.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";
import { AutomodeDriverLive } from "./AutomodeDriver.ts";

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

// Mutable holder so a test can change what listPeers returns between ticks.
function makeLayer(peerStatus: { current: PeerStatus | "absent" }) {
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
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "gits-automode-driver-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const supervisor = AutomodeSupervisorLive.pipe(
    Layer.provide(delamain),
    Layer.provide(usage),
    Layer.provideMerge(config),
    Layer.provideMerge(NodeServices.layer),
  );
  return AutomodeDriverLive.pipe(Layer.provideMerge(supervisor), Layer.provide(delamain));
}

async function armAutonomous(supervisor: AutomodeSupervisor) {
  return supervisor.updatePolicy({
    mode: "autonomous",
    killSwitchEnabled: false,
    maxActivePeers: 1,
    allowedRepos: ["/tmp/source-repo"],
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
    const peerStatus = { current: "running" as PeerStatus | "absent" };
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk vitest run src/gits/Layers/AutomodeDriver.test.ts`
Expected: FAIL — `./AutomodeDriver.ts` (and `AutomodeDriverLive`) does not exist.

- [ ] **Step 3: Implement the driver layer**

Create `apps/server/src/gits/Layers/AutomodeDriver.ts`:

```typescript
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AutomodeGoal, PeerStatus } from "@t3tools/contracts";

import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeDriver, type AutomodeDriverShape } from "../Services/AutomodeDriver.ts";

const TICK_INTERVAL_MS = (() => {
  const raw = process.env.GITS_AUTOMODE_DRIVER_TICK_MS?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

const TERMINAL_FAIL_STATUSES = new Set<PeerStatus>(["failed", "frozen", "killed", "halted"]);
const TERMINAL_DONE_STATUSES = new Set<PeerStatus>(["done", "completed"]);

function oldestQueued(goals: ReadonlyArray<AutomodeGoal>): AutomodeGoal | null {
  const queued = goals
    .filter((goal) => goal.status === "queued")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return queued[0] ?? null;
}

export const AutomodeDriverLive = Layer.scoped(
  AutomodeDriver,
  Effect.gen(function* () {
    const supervisor = yield* AutomodeSupervisor;
    const delamainAdapter = yield* DelamainAdapter;

    const tickOnce: AutomodeDriverShape["tickOnce"] = () =>
      Effect.gen(function* () {
        const snapshot = yield* supervisor.getSnapshot();

        // Only act in autonomous mode with the kill switch off.
        if (snapshot.policy.mode !== "autonomous" || snapshot.policy.killSwitchEnabled) {
          return;
        }

        // 1) Reconcile the in-flight goal (sequential: at most one running).
        const running = snapshot.goals.find(
          (goal) => goal.status === "running" && goal.peerId !== null,
        );
        if (running !== undefined) {
          const peers = yield* delamainAdapter.listPeers().pipe(
            Effect.map((result) => result.peers),
            Effect.catch(() => Effect.succeed([])),
          );
          const peer = peers.find((candidate) => candidate.id === running.peerId);
          if (peer === undefined) {
            return; // peer not yet visible; wait for the next tick
          }

          if (peer.integrationStatus === "failed" || TERMINAL_FAIL_STATUSES.has(peer.status)) {
            yield* supervisor.failGoal({
              goalId: running.id,
              reason: `Peer ${peer.id} ended as ${peer.status}.`,
            });
            yield* supervisor.haltDriver({
              reason: `Halted: ${running.title} failed (${peer.status}).`,
            });
            return;
          }
          if (peer.status === "waiting") {
            yield* supervisor.haltDriver({
              reason: `Halted: peer ${peer.id} is waiting on input for ${running.title}.`,
            });
            return;
          }
          if (TERMINAL_DONE_STATUSES.has(peer.status)) {
            yield* supervisor.completeGoal({ goalId: running.id });
            yield* Effect.logInfo("gits.automode.driver.goal-completed", {
              goalId: running.id,
              peerId: peer.id,
            });
            return;
          }
          return; // pending / running / blocked → still in flight
        }

        // 2) Idle: if halted, wait for an operator resume.
        if (snapshot.driverHalted) {
          return;
        }

        // 3) Dispatch the oldest queued goal (sequential start).
        const next = oldestQueued(snapshot.goals);
        if (next === null) {
          return;
        }
        const result = yield* supervisor.dispatchGoal({ goalId: next.id });
        if (result.peer === null) {
          yield* supervisor.haltDriver({
            reason: result.blockedReason ?? `Dispatch of ${next.title} did not spawn a peer.`,
          });
        }
      });

    // Forked, scoped polling fiber — runs for the lifetime of the layer.
    yield* Effect.forever(
      tickOnce().pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("gits.automode.driver.tick-failed", { error: error.message }),
        ),
        Effect.catchAllDefect((defect) =>
          Effect.logWarning("gits.automode.driver.tick-defect", { defect }),
        ),
        Effect.andThen(Effect.sleep(Duration.millis(TICK_INTERVAL_MS))),
      ),
    ).pipe(Effect.forkScoped);

    yield* Effect.logInfo("gits.automode.driver.started", { tickIntervalMs: TICK_INTERVAL_MS });

    return { tickOnce } satisfies AutomodeDriverShape;
  }),
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk vitest run src/gits/Layers/AutomodeDriver.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
rtk git add apps/server/src/gits/Services/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts
rtk git commit -m "feat(automode): AutomodeDriver sequential autonomous loop with peer-outcome reconciliation"
```

---

## Task 5: Wire AutomodeDriver into the server layer

**Files:**
- Modify: `apps/server/src/server.ts`

- [ ] **Step 1: Import the driver layer**

In `apps/server/src/server.ts`, after the existing automode imports (line 65 `AutomodeUsageMeterLive`), add:

```typescript
import { AutomodeDriverLive } from "./gits/Layers/AutomodeDriver.ts";
```

- [ ] **Step 2: Build the driver layer with its deps**

After the `AutomodeSupervisorLayerLive` block (currently lines 228–231), add:

```typescript
const AutomodeDriverLayerLive = AutomodeDriverLive.pipe(
  Layer.provide(AutomodeSupervisorLayerLive),
  Layer.provide(DelamainCliAdapterLive),
);
```

- [ ] **Step 3: Merge it into `GitsLayerLive`**

In the `GitsLayerLive` aggregation (currently lines 240–264), add a line after `Layer.provideMerge(AutomodeSupervisorLayerLive),` (line 252):

```typescript
  Layer.provideMerge(AutomodeDriverLayerLive),
```

- [ ] **Step 4: Typecheck the server**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk tsc --noEmit`
Expected: PASS. The driver fiber now forks at server boot; it no-ops every tick until an operator arms autonomous mode (default policy is `manual` + kill switch on).

- [ ] **Step 5: Run the full server gits suite to confirm no regressions**

Run: `cd /home/joshua/dev/projects/gitscode/apps/server && rtk vitest run src/gits/Layers/AutomodeSupervisor.test.ts src/gits/Layers/AutomodeDriver.test.ts src/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add apps/server/src/server.ts
rtk git commit -m "feat(automode): wire AutomodeDriver into GITS server layer"
```

---

## Self-Review

**1. Spec coverage (this plan's slice only — the autonomous *spine*):**

| Spec element (`autonomous-toggle.md`) | Task |
|---|---|
| Server-side `AutomodeDriver` loop (Q2) | Tasks 3–5 |
| Sequential, one peer at a time (Q3/Q11) | Task 4 (`running` guard + `oldestQueued`) |
| Poll-tick observation of `listPeers` (Q4) | Task 4 (`tickOnce` reconcile) |
| Goal `running → completed/failed` transitions (the dead-status gap) | Task 2 (`completeGoal`/`failGoal`) |
| `waiting` peer → pause (Q4) | Task 4 (`haltDriver` on `waiting`) |
| Halt-on-hold/fail (Q5) | Task 2 (`haltDriver`, persisted) + Task 4 |
| Resume after halt (Q9) | Task 2 (`resumeDriver`) |
| Persistence across restart (open flag) | Task 2 (persisted `driverHalted`) |
| Respect mode/kill switch (Q9) | Task 4 (early return) |

Deferred-by-design (NOT gaps — see the Scope section): confined-yolo spawn args (Plan 2), held-PR/integration/verifier (Plan 3), ledger summaries (Plan 4), Telegram for the `waiting`/`failed` events currently `logWarning`/`logInfo`'d (Plan 5), auto-answer (Plan 6), Motoko dispatch/grill + per-project keying (Plan 7), cockpit arm/kill/resume UI (Plan 8). The driver dispatches via the existing `dispatchGoal`→`spawnPeer`; confinement is layered in Plan 2 by changing the spawn args, not the loop.

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — every step has full code or an exact command + expected result. ✅

**3. Type consistency:** `completeGoal`/`failGoal` return `AutomodeGoal`; `haltDriver`/`resumeDriver` return `AutomodeSnapshot` (matches the interface in Task 2 Step 1). `AutomodeGoalOutcomeInput` = `{goalId, reason?}` used by `failGoal` (Task 1 + Task 2). `tickOnce()` signature identical in service (Task 3) and impl (Task 4). `PeerStatus` terminal sets use the verified literals (`done`/`completed`/`failed`/`frozen`/`killed`/`halted`/`waiting`). `oldestQueued` sorts ascending by `createdAt` (FIFO) — opposite of the snapshot's display `sortGoals` (desc), intentional. ✅

**Known v1 simplification (documented, not a defect):** ordering is FIFO by `createdAt`; the brainstorm's explicit slice-`order` field is deferred to the Plan 7 importer. Single global `automode-state.json` is used (per-project keying is Plan 7).

---

## Execution Handoff

This is **Plan 1 of an 8-plan sequence** (see the Scope section). It produces working, tested software on its own: a server that, once an operator arms `mode:"autonomous"` for a repo with queued goals, walks them sequentially and halts safely — with everything still mock-spawned/un-confined until Plan 2.

Recommend executing Plan 1, verifying green, then writing Plan 2 (confined-yolo spawn / H0b).

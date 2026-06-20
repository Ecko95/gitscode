# Autonomous Toggle — Plan 3b: Held PR + Merge Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the autonomous loop. When the automode goal queue drains at roadmap end (no queued, no running, ≥1 goal landed this run), the `AutomodeDriver` opens **one held PR** `auto/<integrationBranch> → gits` (never auto-merged). On subsequent ticks it polls GitHub for that PR's merge state; when the operator merges it, the driver marks the run complete and stops.

**Architecture:** A new `AutomodeHeldPr` Effect service (sibling to 3a's `AutomodeLanding`) wraps the existing **`GitHubCli`** service — `open_held_pr` runs `gh pr create` (idempotent: list-first) and `detect_merge` reads `GitHubCli.getPullRequest().state === "merged"` (authoritative — GitHub reports MERGED regardless of merge/squash/rebase strategy and survives branch deletion). The supervisor gains persisted run-state (`heldPrUrl`, `heldPrNumber`, `runMerged`) and two methods (`recordHeldPr`, `markRunMerged`) modelled on `haltDriver`/`resumeDriver`. The driver's idle branch (after the `driverHalted` early-return, at the `oldestQueued === null` point) becomes the open-once-then-poll state machine.

**Tech Stack:** TypeScript, Effect (Layer/Effect/Ref/Schema), `@t3tools/contracts`, `@effect/vitest` (`it.effect`, `Layer.mock`), `@effect/platform-node` (`NodeServices`), vitest. RTK prefix. Conventions: repo style is 2-space (oxfmt normalizes); double quotes, semicolons, snake_case functions, PascalCase types, kebab-case files. Gate each task on `bun fmt` (targeted paths), `bun lint`, `bun typecheck`, `bun run test`. Use direct `tsgo --noEmit` per package for ground-truth typecheck — turbo caches stale success (`[[gitscode-no-ci-verify-locally]]`). Commit after each task.

**Design decisions locked (2026-06-20 checkpoint):**
1. **gh-native merge detection** via `GitHubCli.getPullRequest().state === "merged"` — NOT the git patch-id cascade. (`GitVcsDriver.execute` is git-only and can't run `gh`; `GitHubCli` already shells `gh` and exposes authoritative PR state.) No pushed-SHA / `git cherry` needed.
2. **One held PR per run**, head = `policy.integrationBranch`, base = `gits`, never auto-merged (no `gh pr merge`).
3. **Run is terminal after merge** (v1): once `runMerged` is true the driver stops opening PRs / dispatching. Starting a fresh run (per-project keying, resettable runs) is Plan 7. The repo for `gh` is derived from a completed goal's `repo` (v1 is single-repo per run).

**Builds on:** Plan 3a (merged PR #29). Source of truth: `docs/brainstorms/autonomous-toggle.md`, `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` §74.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/contracts/src/gits.ts` | Add `heldPrUrl`/`heldPrNumber`/`runMerged` to `AutomodeSnapshot`; add `AutomodeRecordHeldPrInput`. | Modify |
| `apps/server/src/gits/Services/AutomodeSupervisor.ts` | Add `recordHeldPr` + `markRunMerged` to the shape. | Modify |
| `apps/server/src/gits/Layers/AutomodeSupervisor.ts` | Add the 3 fields to `AutomodeState` + `PersistedAutomodeState` (decoding defaults) + `toPersisted`/`fromPersisted` + initial state + `makeSnapshot`; implement the 2 methods. | Modify |
| `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts` | Persistence + method cases. | Modify |
| `apps/server/src/gits/Services/AutomodeHeldPr.ts` | New service tag + shape (`open_held_pr`, `detect_merge`). | Create |
| `apps/server/src/gits/Layers/AutomodeHeldPr.ts` | `AutomodeHeldPrLive` over `GitHubCli`. | Create |
| `apps/server/src/gits/Layers/AutomodeHeldPr.test.ts` | Runner tests against a mocked `GitHubCli`. | Create |
| `apps/server/src/gits/Layers/AutomodeDriver.ts` | Idle-branch open-once + poll-merge; inject `AutomodeHeldPr`. | Modify |
| `apps/server/src/gits/Layers/AutomodeDriver.test.ts` | Driver tests: open held PR on drain, poll → merged → runMerged, terminal. | Modify |
| `apps/server/src/server.ts` | Provide `AutomodeHeldPrLive` (over `GitHubCli.layer`) to `AutomodeDriverLayerLive`. | Modify |
| `apps/server/src/server.test.ts` | Add the 3 new snapshot fields to the policy/snapshot fixture. | Modify |

---

## Task 1: Contracts — snapshot run-state + record-held-PR input

**Files:**
- Modify: `packages/contracts/src/gits.ts` (`AutomodeSnapshot` ~691-702; input schemas ~729-749)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/automode-held-pr-fields.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { AutomodeSnapshot, AutomodeRecordHeldPrInput } from "./gits.ts";

const baseSnapshot = {
  policy: {
    mode: "autonomous", killSwitchEnabled: false, maxActivePeers: 1,
    allowedRepos: [], allowedModels: [], defaultModel: null, maxBudgetUsd: null,
    maxRuntimeMinutes: null, requireApprovalForPeerSpawn: false,
    requireApprovalBeforeIntegrate: true, requireApprovalBeforeDestructiveAction: true,
    verificationCommands: [], integrationBranch: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  budgetUsage: { source: "unavailable", totalCostUsd: null, totalProcessedTokens: null, updatedAt: null, note: null },
  goals: [], activePeerCount: 0, pendingApprovalCount: 0,
  driverHalted: false, driverHaltedReason: null,
  lastEvent: null, updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("AutomodeSnapshot held-PR fields", () => {
  it("decodes heldPrUrl/heldPrNumber/runMerged", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeSnapshot)({
      ...baseSnapshot,
      heldPrUrl: "https://github.com/Ecko95/gitscode/pull/30",
      heldPrNumber: 30,
      runMerged: true,
    });
    expect(decoded.heldPrUrl).toContain("/pull/30");
    expect(decoded.heldPrNumber).toBe(30);
    expect(decoded.runMerged).toBe(true);
  });

  it("defaults the new fields for back-compat (absent)", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeSnapshot)(baseSnapshot);
    expect(decoded.heldPrUrl).toBeNull();
    expect(decoded.heldPrNumber).toBeNull();
    expect(decoded.runMerged).toBe(false);
  });

  it("validates the record-held-pr input", () => {
    const decoded = Schema.decodeUnknownSync(AutomodeRecordHeldPrInput)({
      url: "https://github.com/Ecko95/gitscode/pull/30",
      number: 30,
    });
    expect(decoded.number).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run packages/contracts/src/automode-held-pr-fields.test.ts`
Expected: FAIL — fields/schema not defined.

- [ ] **Step 3: Extend `AutomodeSnapshot`**

In `AutomodeSnapshot`, add **before** `lastEvent`, using the same `withDecodingDefault(Effect.succeed(...))` form as `driverHalted` (so snapshots/persisted policy without these fields still decode):

```typescript
  driverHalted: Schema.Boolean,
  driverHaltedReason: Schema.NullOr(SummaryString),
  heldPrUrl: Schema.NullOr(SummaryString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  heldPrNumber: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  runMerged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastEvent: Schema.NullOr(SummaryString),
```

(`Effect` and `NonNegativeInt` are already imported in this file — 3a added the `Effect` import.)

- [ ] **Step 4: Add `AutomodeRecordHeldPrInput`**

Next to the other automode input schemas (after `AutomodeDriverHaltInput`):

```typescript
export const AutomodeRecordHeldPrInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  number: NonNegativeInt,
});
export type AutomodeRecordHeldPrInput = typeof AutomodeRecordHeldPrInput.Type;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run packages/contracts/src/automode-held-pr-fields.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt packages/contracts/src/gits.ts packages/contracts/src/automode-held-pr-fields.test.ts && rtk git add packages/contracts/src/gits.ts packages/contracts/src/automode-held-pr-fields.test.ts && rtk git commit -m "feat(contracts): automode snapshot held-PR run state + record input"
```

---

## Task 2: Supervisor — persist run state + recordHeldPr/markRunMerged

**Files:**
- Modify: `apps/server/src/gits/Services/AutomodeSupervisor.ts` (shape ~17-44)
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts` (state 41-48; persisted 55-66; toPersisted 95-105; fromPersisted 107-116; initial state ~318-325; makeSnapshot ~262-278; methods near `haltDriver`/`resumeDriver` ~671-694)
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `AutomodeSupervisor.test.ts` (inside the `describe`):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: FAIL — `recordHeldPr`/`markRunMerged` not defined; snapshot lacks fields.

- [ ] **Step 3: Add the fields to `AutomodeState`** (Layers file, interface ~41-48)

```typescript
interface AutomodeState {
  readonly policy: AutomodePolicy;
  readonly goals: ReadonlyArray<AutomodeGoal>;
  readonly driverHalted: boolean;
  readonly driverHaltedReason: string | null;
  readonly heldPrUrl: string | null;
  readonly heldPrNumber: number | null;
  readonly runMerged: boolean;
  readonly lastEvent: string | null;
  readonly updatedAt: string;
}
```

- [ ] **Step 4: Add to `PersistedAutomodeState`** (~55-66), mirroring the `driverHalted` decoding-default form:

```typescript
  driverHaltedReason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  heldPrUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  heldPrNumber: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  runMerged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastEvent: Schema.NullOr(Schema.String),
```

- [ ] **Step 5: Thread through `toPersistedAutomodeState` (~95-105), `fromPersistedAutomodeState` (~107-116), and the initial-state literal (~318-325)**

Add `heldPrUrl: state.heldPrUrl, heldPrNumber: state.heldPrNumber, runMerged: state.runMerged` to both mappers, and `heldPrUrl: null, heldPrNumber: null, runMerged: false` to the initial `AutomodeState` passed to `loadAutomodeState`.

- [ ] **Step 6: Surface in `makeSnapshot` (~262-278)**

Add to the returned `AutomodeSnapshot` object: `heldPrUrl: state.heldPrUrl, heldPrNumber: state.heldPrNumber, runMerged: state.runMerged`.

- [ ] **Step 7: Add the two methods** (Layers file, near `resumeDriver` ~683-694)

```typescript
      recordHeldPr: (input) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const reason = `Opened held PR #${input.number} → gits.`;
          const nextState = yield* commitState((state) => ({
            ...state,
            heldPrUrl: input.url,
            heldPrNumber: input.number,
            lastEvent: reason,
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
      markRunMerged: () =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          const nextState = yield* commitState((state) => ({
            ...state,
            runMerged: true,
            lastEvent: "Run complete: held PR merged to gits.",
            updatedAt,
          }));
          return yield* snapshotFromState(nextState);
        }),
```

- [ ] **Step 8: Add the methods to `AutomodeSupervisorShape`** (Services file)

```typescript
  readonly recordHeldPr: (
    input: AutomodeRecordHeldPrInput,
  ) => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
  readonly markRunMerged: () => Effect.Effect<AutomodeSnapshot, AutomodeSupervisorError>;
```

Import `AutomodeRecordHeldPrInput` (type) from `@t3tools/contracts` in the Services file.

- [ ] **Step 9: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck + commit**

```bash
PATH="$HOME/.local/bin:$PATH" cd apps/server && npx tsgo --noEmit   # expect 0 (server.test fixture is fixed in Task 6)
```

> The server typecheck may report the `server.test.ts` snapshot fixture missing the 3 new fields — that is fixed in Task 6. Commit this task now; the targeted unit test is green.

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/gits/Services/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts && rtk git add apps/server/src/gits/Services/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts && rtk git commit -m "feat(automode): persist held-PR run state; recordHeldPr + markRunMerged"
```

---

## Task 3: `AutomodeHeldPr` service tag

**Files:**
- Create: `apps/server/src/gits/Services/AutomodeHeldPr.ts`

- [ ] **Step 1: Define the service**

```typescript
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeOpenHeldPrInput {
  readonly repo: string;
  readonly integrationBranch: string; // PR head
  readonly baseBranch: string; // PR base, e.g. "gits"
  readonly title: string;
  readonly body: string;
}

export type AutomodeOpenHeldPrResult =
  | { readonly status: "opened"; readonly url: string; readonly number: number }
  | { readonly status: "rejected"; readonly reason: string };

export interface AutomodeDetectMergeInput {
  readonly repo: string;
  readonly prNumber: number;
}

export interface AutomodeHeldPrShape {
  readonly open_held_pr: (
    input: AutomodeOpenHeldPrInput,
  ) => Effect.Effect<AutomodeOpenHeldPrResult, AutomodeSupervisorError>;
  readonly detect_merge: (
    input: AutomodeDetectMergeInput,
  ) => Effect.Effect<{ readonly merged: boolean }, AutomodeSupervisorError>;
}

export class AutomodeHeldPr extends Context.Service<AutomodeHeldPr, AutomodeHeldPrShape>()(
  "t3/gits/Services/AutomodeHeldPr",
) {}
```

- [ ] **Step 2: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/gits/Services/AutomodeHeldPr.ts && rtk git add apps/server/src/gits/Services/AutomodeHeldPr.ts && rtk git commit -m "feat(automode): AutomodeHeldPr service tag"
```

---

## Task 4: `AutomodeHeldPrLive` — open via gh, detect via PR state

**Files:**
- Create: `apps/server/src/gits/Layers/AutomodeHeldPr.ts`
- Test: `apps/server/src/gits/Layers/AutomodeHeldPr.test.ts`

- [ ] **Step 1: Read `GitHubCli`**

Read `apps/server/src/sourceControl/GitHubCli.ts`: the `GitHubCli` tag, `execute({cwd, args, timeoutMs?}) → VcsProcessOutput`, `listOpenPullRequests({cwd, headSelector, limit?}) → ReadonlyArray<GitHubPullRequestSummary>`, `getPullRequest({cwd, reference}) → GitHubPullRequestSummary`, and `GitHubPullRequestSummary` (`{ number, url, baseRefName, headRefName, state?: "open"|"closed"|"merged", ... }`). Note `GitHubCli.layer` is `export const layer`.

- [ ] **Step 2: Write the failing test**

```typescript
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitHubCli, type GitHubPullRequestSummary } from "../../sourceControl/GitHubCli.ts";
import { AutomodeHeldPr } from "../Services/AutomodeHeldPr.ts";
import { AutomodeHeldPrLive } from "./AutomodeHeldPr.ts";

function gh(overrides: Partial<{
  list: ReadonlyArray<GitHubPullRequestSummary>;
  created: ReadonlyArray<GitHubPullRequestSummary>;
  get: GitHubPullRequestSummary;
}>) {
  let createCalls = 0;
  return Layer.mock(GitHubCli)({
    execute: () =>
      Effect.sync(() => {
        createCalls += 1;
        return { stdout: "", stderr: "", exitCode: 0 } as never;
      }),
    listOpenPullRequests: () => Effect.succeed(createCalls === 0 ? (overrides.list ?? []) : (overrides.created ?? [])),
    getPullRequest: () =>
      overrides.get
        ? Effect.succeed(overrides.get)
        : Effect.succeed({ number: 30, title: "t", url: "u", baseRefName: "gits", headRefName: "auto/x", state: "open" }),
  });
}

const openInput = {
  repo: "/tmp/repo", integrationBranch: "auto/gits-self", baseBranch: "gits",
  title: "automode held PR", body: "landed slices",
};
const pr: GitHubPullRequestSummary = {
  number: 30, title: "t", url: "https://github.com/o/r/pull/30",
  baseRefName: "gits", headRefName: "auto/gits-self", state: "open",
};

describe("AutomodeHeldPrLive", () => {
  it.effect("returns the existing open PR without creating a duplicate", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
      if (result.status === "opened") assert.equal(result.number, 30);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ list: [pr] }))))),
  );

  it.effect("creates then looks up the PR when none exists yet", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ list: [], created: [pr] }))))),
  );

  it.effect("rejects when the PR still cannot be found after create", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "rejected");
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ list: [], created: [] }))))),
  );

  it.effect("detect_merge true when PR state is merged", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 30 });
      assert.equal(result.merged, true);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ get: { ...pr, state: "merged" } }))))),
  );

  it.effect("detect_merge false when PR state is open", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 30 });
      assert.equal(result.merged, false);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ get: { ...pr, state: "open" } }))))),
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeHeldPr.test.ts`
Expected: FAIL — `AutomodeHeldPrLive` not defined.

- [ ] **Step 4: Implement**

```typescript
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutomodeSupervisorError } from "@t3tools/contracts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { AutomodeHeldPr, type AutomodeHeldPrShape } from "../Services/AutomodeHeldPr.ts";

export const AutomodeHeldPrLive = Layer.effect(
  AutomodeHeldPr,
  Effect.gen(function* () {
    const gh = yield* GitHubCli;

    const findForHead = (repo: string, head: string, base: string) =>
      gh
        .listOpenPullRequests({ cwd: repo, headSelector: head })
        .pipe(
          Effect.map((prs) => prs.find((candidate) => candidate.baseRefName === base) ?? null),
          Effect.mapError(
            (cause) =>
              new AutomodeSupervisorError({ message: "gh pr list failed.", cause }),
          ),
        );

    const open_held_pr: AutomodeHeldPrShape["open_held_pr"] = (input) =>
      Effect.gen(function* () {
        // Idempotent: if a held PR for this head already exists, return it.
        const existing = yield* findForHead(input.repo, input.integrationBranch, input.baseBranch);
        if (existing !== null) {
          return { status: "opened" as const, url: existing.url, number: existing.number };
        }

        yield* gh
          .execute({
            cwd: input.repo,
            args: [
              "pr",
              "create",
              "--base",
              input.baseBranch,
              "--head",
              input.integrationBranch,
              "--title",
              input.title,
              "--body",
              input.body,
            ],
          })
          .pipe(
            Effect.mapError(
              (cause) => new AutomodeSupervisorError({ message: "gh pr create failed.", cause }),
            ),
          );

        const created = yield* findForHead(input.repo, input.integrationBranch, input.baseBranch);
        if (created === null) {
          return {
            status: "rejected" as const,
            reason: `Held PR for ${input.integrationBranch} could not be found after creation.`,
          };
        }
        return { status: "opened" as const, url: created.url, number: created.number };
      });

    const detect_merge: AutomodeHeldPrShape["detect_merge"] = (input) =>
      gh
        .getPullRequest({ cwd: input.repo, reference: String(input.prNumber) })
        .pipe(
          Effect.map((pr) => ({ merged: pr.state === "merged" })),
          Effect.mapError(
            (cause) => new AutomodeSupervisorError({ message: "gh pr view failed.", cause }),
          ),
        );

    return { open_held_pr, detect_merge } satisfies AutomodeHeldPrShape;
  }),
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeHeldPr.test.ts`
Expected: PASS. If `Layer.mock(GitHubCli)` complains about missing methods, provide the exercised ones only (partial mock is supported) and cast the `execute` return with `as never` as shown (its real type is `VcsProcessOutput`).

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/gits/Layers/AutomodeHeldPr.ts apps/server/src/gits/Layers/AutomodeHeldPr.test.ts && rtk git add apps/server/src/gits/Layers/AutomodeHeldPr.ts apps/server/src/gits/Layers/AutomodeHeldPr.test.ts && rtk git commit -m "feat(automode): AutomodeHeldPr — open held PR + gh-native merge detection"
```

---

## Task 5: Driver — open held PR on drain, poll for merge

**Files:**
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the driver test harness (`makeLayer`) to also provide an `AutomodeHeldPr` mock with options `{ openResult?, mergeResults?: boolean[] }` (mergeResults consumed per `detect_merge` call). Then add:

```typescript
it.effect("opens a held PR when the queue drains with a landed goal", () => {
  const peerStatus = { current: "absent" as PeerStatus | "absent" };
  let openCalls = 0;
  return Effect.gen(function* () {
    const supervisor = yield* AutomodeSupervisor;
    const driver = yield* AutomodeDriver;
    yield* armAutonomous(supervisor);
    yield* supervisor.enqueueGoal({ title: "One", repo: "/tmp/source-repo", prompt: "x" });
    yield* driver.tickOnce();            // dispatch
    peerStatus.current = "done";
    yield* driver.tickOnce();            // gate → land → complete
    peerStatus.current = "absent";
    yield* driver.tickOnce();            // queue drained → open held PR

    const snapshot = yield* supervisor.getSnapshot();
    assert.equal(snapshot.heldPrNumber, 30);
    assert.equal(openCalls, 1);
  }).pipe(
    Effect.provide(
      makeLayer(peerStatus, {
        onOpenHeldPr: () => { openCalls += 1; },
        openResult: { status: "opened", url: "https://github.com/o/r/pull/30", number: 30 },
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
    yield* driver.tickOnce();            // dispatch
    peerStatus.current = "done";
    yield* driver.tickOnce();            // land + complete
    peerStatus.current = "absent";
    yield* driver.tickOnce();            // open held PR
    yield* driver.tickOnce();            // poll → not merged
    yield* driver.tickOnce();            // poll → merged

    const snapshot = yield* supervisor.getSnapshot();
    assert.equal(snapshot.runMerged, true);
  }).pipe(
    Effect.provide(
      makeLayer(peerStatus, {
        openResult: { status: "opened", url: "https://github.com/o/r/pull/30", number: 30 },
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
    yield* armAutonomous(supervisor);   // no goals enqueued
    yield* driver.tickOnce();           // drained, nothing landed
    const snapshot = yield* supervisor.getSnapshot();
    assert.equal(snapshot.heldPrUrl, null);
    assert.equal(openCalls, 0);
  }).pipe(Effect.provide(makeLayer(peerStatus, { onOpenHeldPr: () => { openCalls += 1; } })));
});
```

> The `AutomodeHeldPr` mock: `open_held_pr: () => { options.onOpenHeldPr?.(); return Effect.succeed(options.openResult ?? { status: "opened", url: "...", number: 30 }); }`; `detect_merge` returns `Effect.succeed({ merged: (options.mergeResults ?? []).shift() ?? false })` (mutate a copy held in closure). Provide it via `Layer.provide(heldPr)` in `makeLayer`'s returned driver layer.

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeDriver.test.ts`
Expected: FAIL — the driver's idle branch still just returns at `next === null`.

- [ ] **Step 3: Inject the dep + implement the idle state machine**

Add `const heldPr = yield* AutomodeHeldPr;` next to the other deps, and import `AutomodeHeldPr` from `../Services/AutomodeHeldPr.ts`.

Replace the idle `next === null` return block:

```typescript
        // 3) Dispatch the oldest queued goal (sequential start).
        const next = oldestQueued(snapshot.goals);
        if (next === null) {
          return;
        }
```

with the open-once / poll-merge state machine (still after the `driverHalted` early-return, so a halted run does no PR activity):

```typescript
        // 3) Queue drained → held-PR lifecycle, then dispatch.
        const next = oldestQueued(snapshot.goals);
        if (next === null) {
          // Run is terminal once the held PR merged.
          if (snapshot.runMerged) {
            return;
          }
          const policy = snapshot.policy;
          if (policy.integrationBranch === null) {
            return;
          }
          const landedRepo = snapshot.goals.find((goal) => goal.status === "completed")?.repo ?? null;

          if (snapshot.heldPrUrl === null || snapshot.heldPrNumber === null) {
            // Open the held PR exactly once, only if at least one slice landed.
            if (landedRepo === null) {
              return;
            }
            const landedTitles = snapshot.goals
              .filter((goal) => goal.status === "completed")
              .map((goal) => `- ${goal.title}`)
              .join("\n");
            const result = yield* heldPr.open_held_pr({
              repo: landedRepo,
              integrationBranch: policy.integrationBranch,
              baseBranch: "gits",
              title: `automode: held PR for ${policy.integrationBranch}`,
              body: `Autonomous run — landed slices (held for review, not auto-merged):\n\n${landedTitles}`,
            });
            if (result.status === "rejected") {
              yield* supervisor.haltDriver({
                reason: `Halted: could not open held PR — ${result.reason}`,
              });
              return;
            }
            yield* supervisor.recordHeldPr({ url: result.url, number: result.number });
            return;
          }

          // Held PR already open → poll GitHub for the merge.
          if (landedRepo === null) {
            return;
          }
          const detect = yield* heldPr.detect_merge({
            repo: landedRepo,
            prNumber: snapshot.heldPrNumber,
          });
          if (detect.merged) {
            yield* supervisor.markRunMerged();
            yield* Effect.logInfo("gits.automode.run-merged", { heldPrUrl: snapshot.heldPrUrl });
          }
          return;
        }
```

(The dispatch tail — `supervisor.dispatchGoal(...)` + halt-on-null-peer — stays unchanged after this block.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeDriver.test.ts`
Expected: PASS (new + all existing).

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts && rtk git add apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts && rtk git commit -m "feat(automode): open held PR on drain and poll for merge"
```

---

## Task 6: Server layer wiring + snapshot fixture

**Files:**
- Modify: `apps/server/src/server.ts` (`AutomodeDriverLayerLive` ~242-255)
- Modify: `apps/server/src/server.test.ts` (snapshot fixture ~233-246)

- [ ] **Step 1: Provide `AutomodeHeldPrLive`**

Import `import { AutomodeHeldPrLive } from "./gits/Layers/AutomodeHeldPr.ts";` and `GitHubCli` is available via its module (`import * as GitHubCli from "./sourceControl/GitHubCli.ts"` if not already imported — verify; the layer is `GitHubCli.layer`).

Extend `AutomodeDriverLayerLive` (added in 3a) with:

```typescript
const AutomodeHeldPrLayerLive = AutomodeHeldPrLive.pipe(Layer.provide(GitHubCli.layer));

const AutomodeDriverLayerLive = AutomodeDriverLive.pipe(
  Layer.provide(AutomodeSupervisorLayerLive),
  Layer.provide(DelamainCliAdapterLive),
  Layer.provide(AutomodeLandingLayerLive),
  Layer.provide(AutomodeHeldPrLayerLive),
  Layer.provide(
    GitsReviewPipelineLive.pipe(
      Layer.provide(GitsCodexVerifierAdapterLive),
      Layer.provide(GitsSliceCriteriaStoreLive),
      Layer.provide(GitsConfinedVerifyAdapterLive),
    ),
  ),
);
```

> Verify how `GitHubCli` is exported/imported in `server.ts`. If it is not yet imported, add `import * as GitHubCli from "./sourceControl/GitHubCli.ts";` and use `GitHubCli.layer`; if the tag is a class exported directly elsewhere, match the existing import idiom. Confirm `GitHubCli.layer`'s own requirements (it wraps `VcsProcess`) are satisfied at the runtime root — read the layer and provide any missing dep exactly as other consumers do.

- [ ] **Step 2: Fix the `server.test.ts` snapshot fixture**

In `defaultAutomodeSnapshot.policy`/snapshot (~233-246), add the three new snapshot fields after `driverHaltedReason` (the policy fixture already got `verificationCommands`/`integrationBranch` in 3a):

```typescript
  driverHalted: false,
  driverHaltedReason: null,
  heldPrUrl: null,
  heldPrNumber: null,
  runMerged: false,
  lastEvent: "ready",
```

- [ ] **Step 3: Typecheck + boot test**

```bash
PATH="$HOME/.local/bin:$PATH" cd apps/server && npx tsgo --noEmit       # expect 0 errors
PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/server.test.ts apps/server/src/bin.test.ts
```

Expected: typecheck 0; boot tests PASS.

- [ ] **Step 4: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/server.ts apps/server/src/server.test.ts && rtk git add apps/server/src/server.ts apps/server/src/server.test.ts && rtk git commit -m "feat(automode): wire AutomodeHeldPr into the driver layer"
```

---

## Task 7: Full gate + held PR to `gits`

- [ ] **Step 1: Full gate**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun lint && rtk bun typecheck --force && rtk npx vitest run apps/server packages/contracts
```

Expected: lint 0 errors; typecheck 14/14 (exit 0); tests pass. (Known pre-existing flake unrelated to this work: `ProviderRegistry > re-probes when settings change the codex binaryPath` — time-based, passes in isolation. Re-run that file alone to confirm green if it trips under concurrency.)

- [ ] **Step 2: Targeted re-run**

```bash
PATH="$HOME/.local/bin:$PATH" rtk npx vitest run \
  packages/contracts/src/automode-held-pr-fields.test.ts \
  apps/server/src/gits/Layers/AutomodeHeldPr.test.ts \
  apps/server/src/gits/Layers/AutomodeSupervisor.test.ts \
  apps/server/src/gits/Layers/AutomodeDriver.test.ts \
  apps/server/src/server.test.ts
```

- [ ] **Step 3: Push + open the held PR**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git push -u origin feat/automode-held-pr-merge-detect
PATH="$HOME/.local/bin:$PATH" rtk gh pr create --repo Ecko95/gitscode --base gits --head feat/automode-held-pr-merge-detect --title "feat(automode): held-PR pipeline 3b — held PR + gh-native merge detection" --body "Plan 3b. Closes the autonomous loop: on queue drain the driver opens one held PR auto/<id> → gits (no auto-merge) and polls GitHubCli.getPullRequest().state for the merge, then marks the run complete. gh-native detection (not git patch-id). Plan: docs/superpowers/plans/2026-06-20-automode-held-pr-3b-pr-merge-detect.md"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** held PR on roadmap end → Task 5 (idle branch) + Task 4 (`open_held_pr`). Merge detection → Task 4 (`detect_merge`, gh-native) + Task 5 (poll + `markRunMerged`). Run state persisted → Tasks 1/2. Terminal-after-merge → Task 5 (`runMerged` guard). Fail-closed (no integration branch / nothing landed / open failure) → Task 5. Wiring → Task 6.
- **Divergence from the original prompt (intentional, user-approved 2026-06-20):** merge detection is **gh-native** via `GitHubCli.getPullRequest().state`, not the git `merge-base`/`cherry` patch-id cascade — because `GitVcsDriver.execute` is git-only and `GitHubCli` already provides authoritative PR state. No pushed-SHA tracking needed.
- **Placeholder scan:** all code steps carry real code; read-first steps (Task 4 Step 1, Task 6 Step 1) are inspect-then-match against named files.
- **Type consistency:** `AutomodeHeldPr` / `open_held_pr` / `detect_merge` / `AutomodeOpenHeldPrResult` (Task 3) used in Tasks 4–5. `recordHeldPr` / `markRunMerged` / `AutomodeRecordHeldPrInput` (Tasks 1–2) used in Task 5. Snapshot fields `heldPrUrl`/`heldPrNumber`/`runMerged` (Task 1) read in Task 5, surfaced in Task 2's `makeSnapshot`, fixture-patched in Task 6. `GitHubPullRequestSummary.state === "merged"` matches the live `"open"|"closed"|"merged"` union.
- **v1 simplifications (documented):** one terminal run (reset/new-run is Plan 7); `gh` repo derived from a completed goal's `repo` (single-repo v1); base fixed to `gits`.

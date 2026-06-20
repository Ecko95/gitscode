# Autonomous Toggle — Plan 3a: Verifier Gate + Per-Slice Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an autonomous peer finishes (`done`/`completed`), have the `AutomodeDriver` run the `GitsReviewPipeline` verifier gate over the peer's worktree and — on pass — **land** the slice onto a per-repo integration branch (`auto/<id>`), advancing the chain; on fail, fail the goal and halt. This replaces the driver's current bare `completeGoal` call.

**Architecture:** The driver gains two dependencies — `GitsReviewPipeline` (the mechanical-gate + semantic-verifier service that already exists but has no caller yet) and a new `AutomodeLanding` service (a thin wrapper over `GitVcsDriver.execute` that ensures the integration branch exists and fast-forwards it to the verified slice tip). Two pure decision/command-builder modules keep the policy logic unit-testable. `AutomodePolicy` gains `verificationCommands` (the server-pinned suite the gate runs) and `integrationBranch` (the chain target), supplied when arming autonomous mode. v1 is **sequential**: peers spawn from the integration tip and push to a per-slice branch, so landing is a fast-forward of the integration branch to the slice tip. The held PR to `gits` and patch-id merge detection are **Plan 3b** (out of scope here).

**Tech Stack:** TypeScript, Effect (Layer/Effect/Ref/Schema), `@t3tools/contracts` (effect Schema), `@effect/vitest` (`it.effect`, `Layer.mock`), `@effect/platform-node` (`NodeServices`), vitest runner. RTK prefix for commands. Conventions: tabs, double quotes, semicolons, snake_case functions/vars, PascalCase types/components, kebab-case files. Gate every task on `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` (NEVER `bun test`). Commit after each task.

**Design decisions locked for 3a (from the 2026-06-20 design checkpoint):**
1. Verifier runs **criteria-less** — `sliceId = goal.id`, no per-slice acceptance criteria stored (the criteria importer is Plan 7). The gate uses the mechanical suite + the semantic verifier's adversarial "what did it miss". Landing is gated on `mechanicalPassed && verdict !== "fail"`; `verdict === "uncertain"` lands but is **flagged** (recorded in `lastEvent`), because v1 holds everything for review anyway.
2. `verificationCommands` is a **new `AutomodePolicy` field**, supplied at arm time. Empty list ⇒ fail-closed: the driver refuses to land unverified work.
3. This is **Plan 3a only** (gate + landing). Held PR + patch-id merge detection are Plan 3b.

**Source of truth for the whole design:** `docs/brainstorms/autonomous-toggle.md`, `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` (§74 branch topology), and `docs/superpowers/plans/2026-06-07-autonomous-toggle-driver.md` (Plan 1 spine).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/contracts/src/gits.ts` | Add `verificationCommands` + `integrationBranch` to `AutomodePolicy` and `AutomodePolicyUpdateInput`. | Modify |
| `apps/server/src/gits/Layers/AutomodeReviewGate.ts` | Pure `decide_automode_gate(review) → AutomodeGateDecision`. | Create |
| `apps/server/src/gits/Layers/AutomodeReviewGate.test.ts` | Gate decision unit tests. | Create |
| `apps/server/src/gits/Layers/AutomodeLandingCommands.ts` | Pure git-argv builders: ensure-integration-branch + fast-forward-land. | Create |
| `apps/server/src/gits/Layers/AutomodeLandingCommands.test.ts` | Argv builder unit tests. | Create |
| `apps/server/src/gits/Services/AutomodeLanding.ts` | New `AutomodeLanding` service tag + shape (`land_slice`). | Create |
| `apps/server/src/gits/Layers/AutomodeLanding.ts` | `AutomodeLandingLive`: ensure branch + FF-push via `GitVcsDriver.execute`. | Create |
| `apps/server/src/gits/Layers/AutomodeLanding.test.ts` | Landing-runner tests against a faked `GitVcsDriver`. | Create |
| `apps/server/src/gits/Layers/AutomodeSupervisor.ts` | `defaultPolicy` + persisted-schema decoding-defaults for the 2 new fields; `updatePolicy` maps them; dispatch passes `startRef`/`mergeBranch`. | Modify |
| `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts` | Policy-persistence + dispatch-spawn-args cases. | Modify |
| `apps/server/src/gits/Services/AutomodeDriver.ts` | Widen `tickOnce` error channel if needed (review/landing errors are caught in-layer; no signature change expected). | Verify |
| `apps/server/src/gits/Layers/AutomodeDriver.ts` | Replace the `TERMINAL_DONE` branch with gate→land→complete / fail→halt. Add `GitsReviewPipeline` + `AutomodeLanding` deps. | Modify |
| `apps/server/src/gits/Layers/AutomodeDriver.test.ts` | Driver tests: pass→land→complete, mechanical-fail→fail+halt, verdict-fail→fail+halt, non-FF land→halt, uncertain→land+flag, no-verify-commands→halt. | Modify |
| `apps/server/src/server.ts` | Provide `GitsReviewPipelineLive` + `AutomodeLandingLive` (+ `GitVcsDriver`) to `AutomodeDriverLayerLive`. | Modify |

---

## Task 1: Contracts — policy gains `verificationCommands` + `integrationBranch`

**Files:**
- Modify: `packages/contracts/src/gits.ts` (`AutomodePolicy` ~627-641, `AutomodePolicyUpdateInput` ~687-700)

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/automode-policy-fields.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { AutomodePolicy, AutomodePolicyUpdateInput } from "./gits.ts";

describe("AutomodePolicy held-PR fields", () => {
  it("decodes verificationCommands + integrationBranch", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicy)({
      mode: "autonomous",
      killSwitchEnabled: false,
      maxActivePeers: 1,
      allowedRepos: ["/tmp/repo"],
      allowedModels: [],
      defaultModel: null,
      maxBudgetUsd: null,
      maxRuntimeMinutes: null,
      requireApprovalForPeerSpawn: false,
      requireApprovalBeforeIntegrate: true,
      requireApprovalBeforeDestructiveAction: true,
      verificationCommands: [{ label: "typecheck", cmd: ["bun", "typecheck"] }],
      integrationBranch: "auto/gits-self-hosting",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.verificationCommands[0]?.label).toBe("typecheck");
    expect(decoded.integrationBranch).toBe("auto/gits-self-hosting");
  });

  it("defaults the new fields when absent (back-compat with old persisted policy)", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicy)({
      mode: "manual",
      killSwitchEnabled: true,
      maxActivePeers: 1,
      allowedRepos: [],
      allowedModels: [],
      defaultModel: null,
      maxBudgetUsd: null,
      maxRuntimeMinutes: 60,
      requireApprovalForPeerSpawn: true,
      requireApprovalBeforeIntegrate: true,
      requireApprovalBeforeDestructiveAction: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decoded.verificationCommands).toEqual([]);
    expect(decoded.integrationBranch).toBeNull();
  });

  it("accepts the new fields on the update input", () => {
    const decoded = Schema.decodeUnknownSync(AutomodePolicyUpdateInput)({
      mode: "autonomous",
      verificationCommands: [{ label: "test", cmd: ["bun", "run", "test"] }],
      integrationBranch: "auto/x",
    });
    expect(decoded.integrationBranch).toBe("auto/x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run packages/contracts/src/automode-policy-fields.test.ts`
Expected: FAIL — `verificationCommands`/`integrationBranch` not on the schema (decode drops/rejects them; back-compat test fails because the field is missing from the decoded object).

- [ ] **Step 3: Add the fields to `AutomodePolicy`**

In `packages/contracts/src/gits.ts`, in `AutomodePolicy`, add **before** `updatedAt`. Use the **same `withDecodingDefault` form** already used for the persisted halt fields (see commit `d04f3c1b` / `driverHalted`) so old `automode-state.json` policies still decode:

```typescript
  requireApprovalBeforeDestructiveAction: Schema.Boolean,
  verificationCommands: Schema.Array(GitsVerifyCommand).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  integrationBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  updatedAt: IsoDateTime,
```

`GitsVerifyCommand` is already exported from this same file (line ~1272) — no new import needed.

- [ ] **Step 4: Add the fields to `AutomodePolicyUpdateInput`**

```typescript
  requireApprovalBeforeDestructiveAction: Schema.optional(Schema.Boolean),
  verificationCommands: Schema.optional(Schema.Array(GitsVerifyCommand)),
  integrationBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run packages/contracts/src/automode-policy-fields.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add packages/contracts/src/gits.ts packages/contracts/src/automode-policy-fields.test.ts && rtk git commit -m "feat(contracts): automode policy verificationCommands + integrationBranch"
```

---

## Task 2: Supervisor — policy defaults, persistence, and update mapping

**Files:**
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts` (`defaultPolicy` ~160-175, `updatePolicy` ~400-429)
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts` (inside the existing `describe("AutomodeSupervisorLive", …)`):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: FAIL — `integrationBranch`/`verificationCommands` are not on the policy yet (type error or null mismatch).

- [ ] **Step 3: Extend `defaultPolicy`**

In `apps/server/src/gits/Layers/AutomodeSupervisor.ts`, in `defaultPolicy` (the object returned ~160-175), add the two fields:

```typescript
    requireApprovalBeforeDestructiveAction: true,
    verificationCommands: [],
    integrationBranch: null,
    updatedAt: initializedAt,
```

- [ ] **Step 4: Map the fields in `updatePolicy`**

Find `updatePolicy` (~400-429). It builds the next policy by spreading the current policy and overlaying the provided fields (each `input.X ?? current.X`). Add the same pattern for the two new fields, before `updatedAt`:

```typescript
      verificationCommands: input.verificationCommands ?? current.verificationCommands,
      integrationBranch:
        input.integrationBranch !== undefined ? input.integrationBranch : current.integrationBranch,
```

> Note the `!== undefined` form for `integrationBranch`: it is `optional(NullOr(...))`, so `null` is a meaningful "clear it" value distinct from "not provided". Match whatever idiom the neighboring nullable field (`defaultModel`) already uses in this function — mirror it exactly.

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: PASS (all existing + 2 new cases).

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts && rtk git commit -m "feat(automode): persist verificationCommands + integrationBranch in policy"
```

---

## Task 3: Dispatch from the integration tip

The chain only fast-forwards if each peer branches **from the integration tip** and pushes to a **known per-slice branch**. `dispatchGoal` must pass `startRef`/`mergeBranch` to `spawnPeer` when `integrationBranch` is set.

**Files:**
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.ts` (`dispatchGoal` spawn call ~560-575)
- Modify: `apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `AutomodeSupervisor.test.ts`:

```typescript
it.effect("autonomous dispatch spawns from the integration tip to a per-slice branch", () => {
  let spawnInput: DelamainSpawnPeerInput | null = null;
  return Effect.gen(function* () {
    const supervisor = yield* AutomodeSupervisor;
    yield* supervisor.updatePolicy({
      mode: "autonomous",
      killSwitchEnabled: false,
      maxActivePeers: 1,
      allowedRepos: ["/tmp/source-repo"],
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
    Effect.provide(makeLayer({ onSpawn: (input) => { spawnInput = input; } })),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: FAIL — `spawnInput.startRef`/`mergeBranch` are `undefined`.

- [ ] **Step 3: Pass `startRef`/`mergeBranch` in `dispatchGoal`'s `spawnPeer` call**

In `dispatchGoal`, the `delamainAdapter.spawnPeer({ … })` call (currently passes `repo, prompt, name, [model], confine, yolo, egress`) gains the chain args **only when `integrationBranch` is set**:

```typescript
    const peer = yield* delamainAdapter
      .spawnPeer({
        repo: goal.repo,
        prompt: goal.prompt,
        name: goal.title,
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(state.policy.integrationBranch
          ? { startRef: state.policy.integrationBranch, mergeBranch: `auto/slice/${goal.id}` }
          : {}),
        confine: true,
        yolo: true,
        egress: "host",
      })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeSupervisor.test.ts`
Expected: PASS. (The existing `confined --yolo` test still passes — it does not set `integrationBranch`, so no `startRef`/`mergeBranch` are added.)

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/gits/Layers/AutomodeSupervisor.ts apps/server/src/gits/Layers/AutomodeSupervisor.test.ts && rtk git commit -m "feat(automode): dispatch spawns from integration tip to per-slice branch"
```

---

## Task 4: Pure gate decision — `decide_automode_gate`

**Files:**
- Create: `apps/server/src/gits/Layers/AutomodeReviewGate.ts`
- Test: `apps/server/src/gits/Layers/AutomodeReviewGate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import type { GitsReviewResult } from "@t3tools/contracts";
import { decide_automode_gate } from "./AutomodeReviewGate.ts";

function review(overrides: Partial<GitsReviewResult>): GitsReviewResult {
  return {
    sliceId: "goal-1",
    recommendation: "hold-for-review",
    mechanicalPassed: true,
    mechanical: {
      worktree: "/tmp/wt",
      confined: true,
      passed: true,
      results: [],
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    semantic: {
      worktree: "/tmp/wt",
      verdict: "pass",
      confidence: "high",
      recommendation: "hold-for-review",
      reasons: [],
      missed: [],
      criteriaProvided: false,
      model: "gpt-5.5",
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    criteriaSource: "derived",
    summary: "ok",
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as GitsReviewResult;
}

describe("decide_automode_gate", () => {
  it("lands when mechanical passes and verdict is pass", () => {
    const d = decide_automode_gate(review({}));
    expect(d.action).toBe("land");
    expect(d.flagged).toBe(false);
  });

  it("fails when the mechanical gate fails (semantic null)", () => {
    const d = decide_automode_gate(review({ mechanicalPassed: false, semantic: null }));
    expect(d.action).toBe("fail");
  });

  it("fails when the verifier verdict is fail", () => {
    const d = decide_automode_gate(
      review({ semantic: { ...review({}).semantic!, verdict: "fail" } }),
    );
    expect(d.action).toBe("fail");
  });

  it("lands but flags when the verdict is uncertain", () => {
    const d = decide_automode_gate(
      review({ semantic: { ...review({}).semantic!, verdict: "uncertain" } }),
    );
    expect(d.action).toBe("land");
    expect(d.flagged).toBe(true);
  });

  it("treats a missing semantic result (mechanical passed) as uncertain → land+flag", () => {
    const d = decide_automode_gate(review({ semantic: null }));
    expect(d.action).toBe("land");
    expect(d.flagged).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeReviewGate.test.ts`
Expected: FAIL — `decide_automode_gate` not defined.

- [ ] **Step 3: Implement**

```typescript
import type { GitsReviewResult } from "@t3tools/contracts";

export type AutomodeGateAction = "land" | "fail";

export interface AutomodeGateDecision {
	readonly action: AutomodeGateAction;
	readonly flagged: boolean;
	readonly reason: string;
}

// v1 (autoMerge OFF): land iff the mechanical suite passed AND the verifier did not
// reject. "uncertain" (or a skipped/absent semantic result) lands but is flagged for
// the operator's held-PR review. Only "fail" halts the chain.
export function decide_automode_gate(review: GitsReviewResult): AutomodeGateDecision {
	if (!review.mechanicalPassed) {
		return { action: "fail", flagged: false, reason: `Mechanical gate failed: ${review.summary}` };
	}
	const verdict = review.semantic?.verdict ?? "uncertain";
	if (verdict === "fail") {
		return { action: "fail", flagged: false, reason: `Verifier rejected the slice: ${review.summary}` };
	}
	return { action: "land", flagged: verdict === "uncertain", reason: review.summary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeReviewGate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/gits/Layers/AutomodeReviewGate.ts apps/server/src/gits/Layers/AutomodeReviewGate.test.ts && rtk git commit -m "feat(automode): pure verifier-gate decision"
```

---

## Task 5: Pure landing command builders

The integration branch is fast-forwarded to the slice tip. Two pure builders return ordered `{ operation, args }` git-argv records (executed later via `GitVcsDriver.execute`).

**Files:**
- Create: `apps/server/src/gits/Layers/AutomodeLandingCommands.ts`
- Test: `apps/server/src/gits/Layers/AutomodeLandingCommands.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
	build_ensure_integration_branch_commands,
	build_land_slice_commands,
} from "./AutomodeLandingCommands.ts";

describe("automode landing commands", () => {
	it("creates the integration branch from the base ref on origin", () => {
		const cmds = build_ensure_integration_branch_commands({
			integrationBranch: "auto/gits-self",
			baseRef: "gits",
		});
		expect(cmds.map((c) => c.args)).toEqual([
			["fetch", "origin", "gits"],
			["push", "origin", "refs/remotes/origin/gits:refs/heads/auto/gits-self"],
		]);
	});

	it("fast-forwards the integration branch to the slice tip on origin", () => {
		const cmds = build_land_slice_commands({
			sliceBranch: "auto/slice/goal-1",
			integrationBranch: "auto/gits-self",
		});
		expect(cmds.map((c) => c.args)).toEqual([
			["fetch", "origin", "auto/slice/goal-1"],
			[
				"push",
				"origin",
				"refs/remotes/origin/auto/slice/goal-1:refs/heads/auto/gits-self",
			],
		]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeLandingCommands.test.ts`
Expected: FAIL — builders not defined.

- [ ] **Step 3: Implement**

```typescript
export interface AutomodeGitArgv {
	readonly operation: string;
	readonly args: ReadonlyArray<string>;
}

export interface EnsureIntegrationBranchInput {
	readonly integrationBranch: string;
	readonly baseRef: string; // e.g. "gits"
}

// Idempotent create-from-base. The runner only invokes this when the integration
// branch does not yet exist on origin (ls-remote check), so the push is a creation.
export function build_ensure_integration_branch_commands(
	input: EnsureIntegrationBranchInput,
): ReadonlyArray<AutomodeGitArgv> {
	return [
		{ operation: "automode-fetch-base", args: ["fetch", "origin", input.baseRef] },
		{
			operation: "automode-create-integration",
			args: [
				"push",
				"origin",
				`refs/remotes/origin/${input.baseRef}:refs/heads/${input.integrationBranch}`,
			],
		},
	];
}

export interface LandSliceInput {
	readonly sliceBranch: string;
	readonly integrationBranch: string;
}

// Fast-forward the integration branch to the verified slice tip. Because the peer
// branched FROM the integration tip (Task 3) and v1 is sequential, this push is a
// fast-forward; a non-FF rejection means the chain diverged and the runner halts.
export function build_land_slice_commands(input: LandSliceInput): ReadonlyArray<AutomodeGitArgv> {
	return [
		{ operation: "automode-fetch-slice", args: ["fetch", "origin", input.sliceBranch] },
		{
			operation: "automode-land-slice",
			args: [
				"push",
				"origin",
				`refs/remotes/origin/${input.sliceBranch}:refs/heads/${input.integrationBranch}`,
			],
		},
	];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeLandingCommands.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/gits/Layers/AutomodeLandingCommands.ts apps/server/src/gits/Layers/AutomodeLandingCommands.test.ts && rtk git commit -m "feat(automode): pure git-argv builders for slice landing"
```

---

## Task 6: `AutomodeLanding` service — ensure branch + FF-push

**Files:**
- Create: `apps/server/src/gits/Services/AutomodeLanding.ts`
- Create: `apps/server/src/gits/Layers/AutomodeLanding.ts`
- Test: `apps/server/src/gits/Layers/AutomodeLanding.test.ts`

- [ ] **Step 1: Read the `GitVcsDriver` surface**

Read `apps/server/src/vcs/GitVcsDriver.ts`:
- the `GitVcsDriver` Context tag,
- `execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>` where `ExecuteGitInput = { operation, cwd, args }` and `ExecuteGitResult = { exitCode, stdout, stderr, stdoutTruncated, stderrTruncated }`.

Confirm the exact import paths/names; the test mock must match them.

- [ ] **Step 2: Define the service tag**

`apps/server/src/gits/Services/AutomodeLanding.ts`:

```typescript
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AutomodeSupervisorError } from "@t3tools/contracts";

export interface AutomodeLandSliceInput {
	readonly repo: string;
	readonly integrationBranch: string;
	readonly baseRef: string; // branch the integration line is cut from, e.g. "gits"
	readonly sliceBranch: string;
}

export type AutomodeLandResult =
	| { readonly status: "landed" }
	| { readonly status: "rejected"; readonly reason: string };

export interface AutomodeLandingShape {
	readonly land_slice: (
		input: AutomodeLandSliceInput,
	) => Effect.Effect<AutomodeLandResult, AutomodeSupervisorError>;
}

export class AutomodeLanding extends Context.Service<AutomodeLanding, AutomodeLandingShape>()(
	"t3/gits/Services/AutomodeLanding",
) {}
```

> The error channel is `AutomodeSupervisorError` so the driver's `tickOnce` channel is unchanged. A non-fast-forward push is a **value** (`{ status: "rejected" }`), not an error — only an unexpected git failure (e.g. fetch network error) becomes an `AutomodeSupervisorError`.

- [ ] **Step 3: Write the failing test**

`apps/server/src/gits/Layers/AutomodeLanding.test.ts`:

```typescript
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { AutomodeLandingLive } from "./AutomodeLanding.ts";

function gitDriverMock(handler: (args: ReadonlyArray<string>) => { exitCode: number; stderr?: string }) {
	return Layer.mock(GitVcsDriver)({
		execute: (input) =>
			Effect.sync(() => {
				const { exitCode, stderr } = handler(input.args);
				return {
					exitCode,
					stdout: "",
					stderr: stderr ?? "",
					stdoutTruncated: false,
					stderrTruncated: false,
				};
			}),
	} as never);
}

const landInput = {
	repo: "/tmp/repo",
	integrationBranch: "auto/gits-self",
	baseRef: "gits",
	sliceBranch: "auto/slice/goal-1",
};

describe("AutomodeLandingLive", () => {
	it.effect("fast-forwards the integration branch when it already exists", () =>
		Effect.gen(function* () {
			const seen: string[][] = [];
			const landing = yield* AutomodeLanding;
			const result = yield* landing.land_slice(landInput);
			assert.equal(result.status, "landed");
		}).pipe(
			Effect.provide(
				AutomodeLandingLive.pipe(
					Layer.provide(
						gitDriverMock((args) => {
							// ls-remote integration branch → exists (exit 0)
							if (args[0] === "ls-remote") return { exitCode: 0 };
							return { exitCode: 0 };
						}),
					),
				),
			),
		),
	);

	it.effect("creates the integration branch first when ls-remote reports it absent", () =>
		Effect.gen(function* () {
			const landing = yield* AutomodeLanding;
			const result = yield* landing.land_slice(landInput);
			assert.equal(result.status, "landed");
		}).pipe(
			Effect.provide(
				AutomodeLandingLive.pipe(
					Layer.provide(
						gitDriverMock((args) => {
							if (args[0] === "ls-remote") return { exitCode: 2 }; // absent
							return { exitCode: 0 };
						}),
					),
				),
			),
		),
	);

	it.effect("returns rejected (not an error) when the FF push is refused", () =>
		Effect.gen(function* () {
			const landing = yield* AutomodeLanding;
			const result = yield* landing.land_slice(landInput);
			assert.equal(result.status, "rejected");
		}).pipe(
			Effect.provide(
				AutomodeLandingLive.pipe(
					Layer.provide(
						gitDriverMock((args) => {
							if (args[0] === "ls-remote") return { exitCode: 0 };
							if (args[0] === "push" && args.includes(
								"refs/remotes/origin/auto/slice/goal-1:refs/heads/auto/gits-self",
							)) return { exitCode: 1, stderr: "! [rejected] (non-fast-forward)" };
							return { exitCode: 0 };
						}),
					),
				),
			),
		),
	);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeLanding.test.ts`
Expected: FAIL — `AutomodeLandingLive` not defined.

- [ ] **Step 5: Implement `AutomodeLandingLive`**

`apps/server/src/gits/Layers/AutomodeLanding.ts`:

```typescript
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutomodeSupervisorError } from "@t3tools/contracts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { AutomodeLanding, type AutomodeLandingShape } from "../Services/AutomodeLanding.ts";
import {
	build_ensure_integration_branch_commands,
	build_land_slice_commands,
	type AutomodeGitArgv,
} from "./AutomodeLandingCommands.ts";

export const AutomodeLandingLive = Layer.effect(
	AutomodeLanding,
	Effect.gen(function* () {
		const git = yield* GitVcsDriver;

		const run = (repo: string, command: AutomodeGitArgv) =>
			git
				.execute({ operation: command.operation, cwd: repo, args: [...command.args] })
				.pipe(
					Effect.mapError(
						(cause) =>
							new AutomodeSupervisorError({
								message: `git ${command.args.join(" ")} failed.`,
								cause,
							}),
					),
				);

		const land_slice: AutomodeLandingShape["land_slice"] = (input) =>
			Effect.gen(function* () {
				// 1) Ensure the integration branch exists on origin (create from baseRef if absent).
				const exists = yield* git
					.execute({
						operation: "automode-ls-integration",
						cwd: input.repo,
						args: ["ls-remote", "--exit-code", "origin", `refs/heads/${input.integrationBranch}`],
					})
					.pipe(
						Effect.map((result) => result.exitCode === 0),
						Effect.mapError(
							(cause) =>
								new AutomodeSupervisorError({ message: "git ls-remote failed.", cause }),
						),
					);

				if (!exists) {
					for (const command of build_ensure_integration_branch_commands({
						integrationBranch: input.integrationBranch,
						baseRef: input.baseRef,
					})) {
						yield* run(input.repo, command);
					}
				}

				// 2) Fast-forward the integration branch to the slice tip.
				const commands = build_land_slice_commands({
					sliceBranch: input.sliceBranch,
					integrationBranch: input.integrationBranch,
				});
				yield* run(input.repo, commands[0]!); // fetch slice — a real failure throws

				const push = yield* git
					.execute({
						operation: commands[1]!.operation,
						cwd: input.repo,
						args: [...commands[1]!.args],
					})
					.pipe(
						Effect.mapError(
							(cause) => new AutomodeSupervisorError({ message: "git push failed.", cause }),
						),
					);

				if (push.exitCode !== 0) {
					return {
						status: "rejected" as const,
						reason: `Integration branch could not fast-forward to ${input.sliceBranch} (non-fast-forward). ${push.stderr.trim()}`,
					};
				}
				return { status: "landed" as const };
			});

		return { land_slice } satisfies AutomodeLandingShape;
	}),
);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeLanding.test.ts`
Expected: PASS. If the `GitVcsDriver` mock shape complains, align the mock's method set to the real `GitVcsDriverShape` (only `execute` is exercised — the `as never` cast in the test covers the unused members; if the codebase forbids that cast, provide the full method set with `Effect.die` stubs, mirroring how other tests mock `GitVcsDriver`).

- [ ] **Step 7: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/gits/Services/AutomodeLanding.ts apps/server/src/gits/Layers/AutomodeLanding.ts apps/server/src/gits/Layers/AutomodeLanding.test.ts && rtk git commit -m "feat(automode): AutomodeLanding service (ensure branch + FF-push slice)"
```

---

## Task 7: Driver — gate → land → complete / fail → halt

Replace the `TERMINAL_DONE_STATUSES` branch in `tickOnce`. The driver gains `GitsReviewPipeline` and `AutomodeLanding` dependencies.

**Files:**
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/gits/Layers/AutomodeDriver.test.ts`, extend `makeLayer` (or the driver test harness) to also provide mocks for `GitsReviewPipeline` and `AutomodeLanding`, parameterized like the existing `DelamainAdapter` mock. Then add:

```typescript
it.effect("on done: verifier passes → lands the slice → completes the goal", () =>
	Effect.gen(function* () {
		const driver = yield* AutomodeDriver;
		yield* driver.tickOnce(); // dispatch
		yield* driver.tickOnce(); // reconcile done → gate → land → complete
		const supervisor = yield* AutomodeSupervisor;
		const snapshot = yield* supervisor.getSnapshot();
		assert.equal(snapshot.goals[0]?.status, "completed");
	}).pipe(
		Effect.provide(
			makeDriverLayer({
				policy: autonomousPolicyWithVerify,
				peerStatus: "done",
				review: passingReview,
				landResult: { status: "landed" },
			}),
		),
	),
);

it.effect("on done: verifier fails → fails the goal and halts", () =>
	Effect.gen(function* () {
		const driver = yield* AutomodeDriver;
		yield* driver.tickOnce();
		yield* driver.tickOnce();
		const snapshot = yield* (yield* AutomodeSupervisor).getSnapshot();
		assert.equal(snapshot.goals[0]?.status, "failed");
		assert.equal(snapshot.driverHalted, true);
	}).pipe(
		Effect.provide(
			makeDriverLayer({
				policy: autonomousPolicyWithVerify,
				peerStatus: "done",
				review: failingReview,
			}),
		),
	),
);

it.effect("on done: non-fast-forward landing → halts without completing", () =>
	Effect.gen(function* () {
		const driver = yield* AutomodeDriver;
		yield* driver.tickOnce();
		yield* driver.tickOnce();
		const snapshot = yield* (yield* AutomodeSupervisor).getSnapshot();
		assert.equal(snapshot.driverHalted, true);
		assert.notEqual(snapshot.goals[0]?.status, "completed");
	}).pipe(
		Effect.provide(
			makeDriverLayer({
				policy: autonomousPolicyWithVerify,
				peerStatus: "done",
				review: passingReview,
				landResult: { status: "rejected", reason: "non-fast-forward" },
			}),
		),
	),
);

it.effect("on done: empty verificationCommands → halts (fail-closed), no land", () =>
	Effect.gen(function* () {
		let landed = false;
		const driver = yield* AutomodeDriver;
		yield* driver.tickOnce();
		yield* driver.tickOnce();
		const snapshot = yield* (yield* AutomodeSupervisor).getSnapshot();
		assert.equal(snapshot.driverHalted, true);
	}).pipe(
		Effect.provide(
			makeDriverLayer({
				policy: { ...autonomousPolicyWithVerify, verificationCommands: [] },
				peerStatus: "done",
				review: passingReview,
			}),
		),
	),
);
```

> Define the helpers (`makeDriverLayer`, `autonomousPolicyWithVerify`, `passingReview`, `failingReview`) in the test file, mirroring the existing driver-test harness. `passingReview`/`failingReview` are `GitsReviewResult` literals (reuse the `review()` factory shape from Task 4's test). `makeDriverLayer` provides: a real `AutomodeSupervisorLive` (so goal state transitions are observable) seeded with one queued goal + the given policy, a `DelamainAdapter` mock whose `listPeers` returns one peer with the given `peerStatus` and a `branch`/`worktreePath`, a `GitsReviewPipeline` mock returning `review`, and an `AutomodeLanding` mock returning `landResult` (default `{ status: "landed" }`). Model the supervisor seeding on the existing persistence test (write policy via `updatePolicy`, enqueue one goal, then `dispatchGoal` happens through `tickOnce`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeDriver.test.ts`
Expected: FAIL — the driver still calls bare `completeGoal` (passing review completes without landing; failing review still completes; no halt on non-FF).

- [ ] **Step 3: Implement the gate→land branch in `tickOnce`**

In `apps/server/src/gits/Layers/AutomodeDriver.ts`:

1. Acquire the new deps at the top of the layer effect (next to `AutomodeSupervisor`/`DelamainAdapter`):

```typescript
		const reviewPipeline = yield* GitsReviewPipeline;
		const landing = yield* AutomodeLanding;
```

with imports:

```typescript
import { GitsReviewPipeline } from "../Services/GitsReviewPipeline.ts";
import { AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { decide_automode_gate } from "./AutomodeReviewGate.ts";
```

2. Replace the existing terminal-done block:

```typescript
			if (TERMINAL_DONE_STATUSES.has(peer.status)) {
				yield* supervisor.completeGoal({ goalId: running.id });
				yield* Effect.logInfo("gits.automode.driver.goal-completed", {
					goalId: running.id,
					peerId: peer.id,
				});
				return;
			}
```

with the gate → land → complete / fail → halt flow:

```typescript
			if (TERMINAL_DONE_STATUSES.has(peer.status)) {
				const policy = snapshot.policy;

				// Fail closed: never land work that was not verified, and never land without a target.
				if (policy.integrationBranch === null) {
					yield* supervisor.haltDriver({
						reason: `Halted: ${running.title} finished but no integration branch is configured.`,
					});
					return;
				}
				if (policy.verificationCommands.length === 0) {
					yield* supervisor.haltDriver({
						reason: `Halted: ${running.title} finished but no verification commands are configured.`,
					});
					return;
				}
				if (peer.worktreePath === null || peer.branch === null) {
					yield* supervisor.haltDriver({
						reason: `Halted: peer ${peer.id} has no worktree/branch to verify and land.`,
					});
					return;
				}

				const review = yield* reviewPipeline
					.review({
						worktree: peer.worktreePath,
						baseRef: policy.integrationBranch,
						sliceId: running.id,
						verificationCommands: policy.verificationCommands,
					})
					.pipe(
						Effect.mapError(
							(cause) =>
								new AutomodeSupervisorError({
									message: `Verifier failed for ${running.title}.`,
									cause,
								}),
						),
					);

				const decision = decide_automode_gate(review);
				if (decision.action === "fail") {
					yield* supervisor.failGoal({ goalId: running.id, reason: decision.reason });
					yield* supervisor.haltDriver({
						reason: `Halted: ${running.title} failed review — ${decision.reason}`,
					});
					return;
				}

				const landResult = yield* landing.land_slice({
					repo: running.repo,
					integrationBranch: policy.integrationBranch,
					baseRef: "gits",
					sliceBranch: peer.branch,
				});
				if (landResult.status === "rejected") {
					yield* supervisor.haltDriver({
						reason: `Halted: ${running.title} passed review but could not land — ${landResult.reason}`,
					});
					return;
				}

				yield* supervisor.completeGoal({ goalId: running.id });
				yield* Effect.logInfo("gits.automode.driver.goal-landed", {
					goalId: running.id,
					peerId: peer.id,
					flagged: decision.flagged,
				});
				return;
			}
```

3. Ensure `AutomodeSupervisorError` is imported (from `@t3tools/contracts`) and the layer dependency list / `Layer.effect` requirements now include `GitsReviewPipeline` and `AutomodeLanding`.

> `baseRef: "gits"` is the v1 chain root (the deploy branch). When per-project keying lands (Plan 7), this becomes the project's configured base; for 3a it is fixed to `gits` to match the design's `auto/<id>` off `origin/gits`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeDriver.test.ts`
Expected: PASS (new cases + all existing driver cases — the existing "completes" test must be updated to provide passing review + landing, since completion now requires landing; update it in this step).

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts && rtk git commit -m "feat(automode): gate completed peers and land verified slices onto integration branch"
```

---

## Task 8: Server layer wiring

`AutomodeDriverLayerLive` must now be provided `GitsReviewPipeline`, `AutomodeLanding`, and (transitively) `GitVcsDriver`.

**Files:**
- Modify: `apps/server/src/server.ts` (`AutomodeDriverLayerLive` ~241-245)

- [ ] **Step 1: Provide the new layers**

Locate `AutomodeDriverLayerLive` (added in Plan 1):

```typescript
const AutomodeDriverLayerLive = AutomodeDriverLive.pipe(
  Layer.provide(AutomodeSupervisorLayerLive),
  Layer.provide(DelamainCliAdapterLive),
);
```

Extend it to satisfy the two new requirements. `GitsReviewPipelineLive` already exists and is composed in `GitsLayerLive`; build a self-contained instance for the driver (Effect memoizes by reference, so sharing the same underlying layers is fine), and provide `AutomodeLandingLive` over `GitVcsDriver.layer`:

```typescript
const AutomodeLandingLayerLive = AutomodeLandingLive.pipe(
  Layer.provide(GitVcsDriver.layer),
);

const AutomodeDriverLayerLive = AutomodeDriverLive.pipe(
  Layer.provide(AutomodeSupervisorLayerLive),
  Layer.provide(DelamainCliAdapterLive),
  Layer.provide(AutomodeLandingLayerLive),
  Layer.provide(
    GitsReviewPipelineLive.pipe(
      Layer.provide(GitsCodexVerifierAdapterLive),
      Layer.provide(GitsSliceCriteriaStoreLive),
      Layer.provide(GitsConfinedVerifyAdapterLive),
    ),
  ),
);
```

Add imports at the top of `server.ts`:

```typescript
import { AutomodeLandingLive } from "./gits/Layers/AutomodeLanding.ts";
```

`GitsReviewPipelineLive`, `GitsCodexVerifierAdapterLive`, `GitsSliceCriteriaStoreLive`, `GitsConfinedVerifyAdapterLive`, and `GitVcsDriver` are already imported in `server.ts` (verify; if `GitsReviewPipelineLive` is not yet imported, add it from `./gits/Layers/GitsReviewPipeline.ts`).

> Confirm the exact dependency set `GitsReviewPipelineLive` needs by reading `apps/server/src/gits/Layers/GitsReviewPipeline.ts` — provide exactly those (`GitsVerificationGate`, `GitsSemanticVerifier`, `GitsSliceCriteriaStore`) via their existing `*Live` layers, mirroring how `GitsLayerLive` composes them (lines ~270-278). If a required collaborator is named differently, match the real name.

- [ ] **Step 2: Typecheck**

Run: `PATH="$HOME/.local/bin:$PATH" cd apps/server && npx tsgo --noEmit`
Expected: 0 errors. (Use direct `tsgo`, not turbo — see `[[gitscode-no-ci-verify-locally]]`: turbo caches stale success.)

- [ ] **Step 3: Run the server boot/layer test**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/server.test.ts`
Expected: PASS — the runtime layer still builds (the driver's new requirements are satisfied).

- [ ] **Step 4: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/server.ts && rtk git commit -m "feat(automode): wire review pipeline + landing into the driver layer"
```

---

## Task 9: Full gate + integration sanity

- [ ] **Step 1: Format, lint, typecheck, test (whole repo)**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt && rtk bun lint && rtk bun typecheck --force && rtk bun run test
```

Expected: all PASS. (`--force` defeats turbo's stale-success cache; verify `apps/server` and `apps/desktop` are green.)

- [ ] **Step 2: Targeted re-run of every file this plan touched**

```bash
PATH="$HOME/.local/bin:$PATH" rtk npx vitest run \
  packages/contracts/src/automode-policy-fields.test.ts \
  apps/server/src/gits/Layers/AutomodeReviewGate.test.ts \
  apps/server/src/gits/Layers/AutomodeLandingCommands.test.ts \
  apps/server/src/gits/Layers/AutomodeLanding.test.ts \
  apps/server/src/gits/Layers/AutomodeSupervisor.test.ts \
  apps/server/src/gits/Layers/AutomodeDriver.test.ts \
  apps/server/src/server.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Push the branch and open a PR to `gits`**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git push -u origin feat/automode-held-pr-pipeline
PATH="$HOME/.local/bin:$PATH" rtk gh pr create --repo Ecko95/gitscode --base gits --head feat/automode-held-pr-pipeline --title "feat(automode): held-PR pipeline 3a — verifier gate + per-slice landing" --body "Plan 3a of the autonomous-toggle roadmap. Gates completed peers through GitsReviewPipeline and fast-forwards verified slices onto the integration branch. Held PR + patch-id merge detection are Plan 3b. Plan: docs/superpowers/plans/2026-06-20-automode-held-pr-3a-gate-landing.md"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** verifier gate on completion → Task 7. Per-slice landing onto integration branch → Tasks 5/6/7. `verificationCommands` policy field → Task 1/2. Dispatch from integration tip (chain prerequisite) → Task 3. Fail-closed (no integration branch / no verify commands / no worktree) → Task 7. Held PR + patch-id merge detection → **explicitly deferred to Plan 3b** (not in this plan). Criteria-less verifier → Task 7 passes no criteria; `sliceId = goal.id`.
- **Placeholder scan:** every code step carries real code; no TBD/"handle errors"/"similar to". The two read-first steps (Task 6 Step 1, Task 8 Step 1 note) are inspect-then-match against named files, not silent guesses.
- **Type consistency:** `decide_automode_gate` / `AutomodeGateDecision` (Task 4) used in Task 7. `build_ensure_integration_branch_commands` / `build_land_slice_commands` / `AutomodeGitArgv` (Task 5) used in Task 6. `AutomodeLanding` / `land_slice` / `AutomodeLandSliceInput` / `AutomodeLandResult` (Task 6) used in Task 7. `verificationCommands` / `integrationBranch` (Task 1) used in Tasks 2/3/7. `GitsReviewInput` fields (`worktree`, `baseRef`, `sliceId`, `verificationCommands`) and `GitsReviewResult` fields (`mechanicalPassed`, `semantic.verdict`, `summary`) match the live contracts (verified against `packages/contracts/src/gits.ts`).
- **Known v1 simplifications (documented, not defects):** landing is a fast-forward push (valid because v1 is sequential and peers branch from the tip — Task 3); `baseRef` is fixed to `gits` (per-project base is Plan 7); the held PR + merge-detection that close the loop are Plan 3b; verifier runs criteria-less (criteria importer is Plan 7).

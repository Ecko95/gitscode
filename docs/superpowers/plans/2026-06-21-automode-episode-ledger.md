# Autonomous Toggle — Plan 4: Episode Ledger (SQLite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a per-landed-slice **episode** record — the verifier-critic output (verdict, confidence, reasons, key misses, summary) plus goal id/title/repo and the slice branch — into the shared SQLite DB, and expose a read-back API (`record_episode`, `list_episodes`) so a future brain (Motoko) and the cockpit can rehydrate what each autonomous run did without reading transcripts.

**Architecture:** A new `AutomodeEpisodeLedger` Effect service in the **persistence** layer, mirroring `ProviderSessionRuntimeRepository` exactly (record `Schema.Struct` + `…Shape` + `Context.Service` tag in `Services/`; `Layer.effect` impl in `Layers/` using `SqlClient` + `SqlSchema.void`/`findAll`; a new migration `032_AutomodeEpisodeLedger.ts`; an error-type alias in `Errors.ts`). The full `GitsReviewResult` is stored as a JSON TEXT column for lossless rehydrate, with `verdict`/`confidence`/`recommendation`/`flagged`/`summary`/`repo` extracted into typed columns for querying. The `AutomodeDriver` done-path writes one episode immediately after `supervisor.completeGoal` (where the review result + decision are in scope). v1 uses the single shared `state.sqlite` with a `repo` column (per-project keying is Plan 7).

**Tech Stack:** TypeScript, Effect (Layer/Effect/Schema), `effect/unstable/sql` (`SqlClient`, `SqlSchema`, `Migrator`), `@t3tools/contracts`, `@effect/vitest` (`it.layer` + in-memory `SqlitePersistenceMemory`), vitest. RTK prefix. Conventions: repo style is 2-space (oxfmt normalizes); double quotes, semicolons, snake_case functions, PascalCase types, kebab-case-ish file names follow the existing `PascalCase.ts` persistence convention (e.g. `AutomodeEpisodeLedger.ts`). Gate each task on `bun fmt` (targeted), `bun lint`, direct `tsgo --noEmit` per package (turbo caches stale success — `[[gitscode-no-ci-verify-locally]]`), and `bun run test`. Commit after each task.

**Design decisions locked (2026-06-21 checkpoint):**
1. **Shared `state.sqlite`** via migration **032** (031 is taken by visual-plan), table `automode_episodes` with a `repo` column for per-project queries now and Plan-7 partitioning later. No separate DB file (no precedent; `stateDir` is global).
2. **Write + read-back**: `record_episode` (driver writes on each landed slice) + `list_episodes({ repo? })` (newest-first) for rehydrate.
3. **One row per landed slice** (the design's "per-peer summary"). Episodes are recorded only on the success path (after `completeGoal`); failed/halted goals are not episodes in v1. PR url is NOT on the episode (it's per-run, opened later in 3b); rehydrate joins on `repo` + run state if needed.

**Builds on:** Plans 1–3 (merged: #25/#27/#29/#31). Source of truth: `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` §81 (verifier-critic IS the per-peer summary → per-project SQLite episode ledger).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/server/src/persistence/Services/AutomodeEpisodeLedger.ts` | Record schema + `AutomodeEpisodeLedgerShape` + `Context.Service` tag + input schemas. | Create |
| `apps/server/src/persistence/Layers/AutomodeEpisodeLedger.ts` | `AutomodeEpisodeLedgerLive` — `SqlSchema` insert + list, JSON column mapping, decode. | Create |
| `apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts` | In-memory SQLite repo tests (write + list + JSON round-trip + repo filter). | Create |
| `apps/server/src/persistence/Migrations/032_AutomodeEpisodeLedger.ts` | `CREATE TABLE IF NOT EXISTS automode_episodes` + indexes. | Create |
| `apps/server/src/persistence/Migrations.ts` | Register migration 032 (import + `migrationEntries`). | Modify |
| `apps/server/src/persistence/Errors.ts` | `AutomodeEpisodeLedgerRepositoryError` union alias. | Modify |
| `apps/server/src/gits/Layers/AutomodeDriver.ts` | Inject `AutomodeEpisodeLedger`; record an episode after `completeGoal`. | Modify |
| `apps/server/src/gits/Layers/AutomodeDriver.test.ts` | Assert an episode is recorded on the landed-slice path. | Modify |
| `apps/server/src/server.ts` | Provide `AutomodeEpisodeLedgerLive` (over `PersistenceLayerLive`) to `AutomodeDriverLayerLive`. | Modify |

---

## Task 1: Migration 032 — `automode_episodes` table

**Files:**
- Create: `apps/server/src/persistence/Migrations/032_AutomodeEpisodeLedger.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`

- [ ] **Step 1: Write the migration** (mirror `004_ProviderSessionRuntime.ts`)

```typescript
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automode_episodes (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_title TEXT NOT NULL,
      slice_branch TEXT,
      verdict TEXT NOT NULL,
      confidence TEXT,
      recommendation TEXT NOT NULL,
      flagged INTEGER NOT NULL,
      summary TEXT NOT NULL,
      review_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automode_episodes_repo_created
    ON automode_episodes(repo, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automode_episodes_goal
    ON automode_episodes(goal_id)
  `;
});
```

> `flagged` is stored as `INTEGER` (0/1) — SQLite has no boolean. The DB-row schema (Task 3) maps it via `Schema.transform` to/from `boolean`.

- [ ] **Step 2: Register it in `Migrations.ts`**

Add the import after `Migration0031` (visual-plan):

```typescript
import Migration0032 from "./Migrations/032_AutomodeEpisodeLedger.ts";
```

Add the entry after `[31, "ProjectionThreadVisualPlans", Migration0031],` in `migrationEntries`:

```typescript
  [32, "AutomodeEpisodeLedger", Migration0032],
```

- [ ] **Step 3: Typecheck**

Run: `PATH="$HOME/.local/bin:$PATH" cd apps/server && npx tsgo --noEmit`
Expected: 0 errors (migration is a self-contained Effect; no consumers yet).

- [ ] **Step 4: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/persistence/Migrations/032_AutomodeEpisodeLedger.ts apps/server/src/persistence/Migrations.ts && rtk git add apps/server/src/persistence/Migrations/032_AutomodeEpisodeLedger.ts apps/server/src/persistence/Migrations.ts && rtk git commit -m "feat(persistence): migration 032 — automode_episodes table"
```

---

## Task 2: Error type alias

**Files:**
- Modify: `apps/server/src/persistence/Errors.ts`

- [ ] **Step 1: Add the union alias**

Next to the other `*RepositoryError` aliases (~line 106):

```typescript
export type AutomodeEpisodeLedgerRepositoryError = PersistenceSqlError | PersistenceDecodeError;
```

- [ ] **Step 2: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/persistence/Errors.ts && rtk git commit -m "feat(persistence): AutomodeEpisodeLedger error type"
```

---

## Task 3: Ledger service tag + record schema

**Files:**
- Create: `apps/server/src/persistence/Services/AutomodeEpisodeLedger.ts`

- [ ] **Step 1: Define the record, inputs, shape, and tag** (mirror `Services/ProviderSessionRuntime.ts`)

```typescript
import {
  GitsReviewResult,
  GitsVerifierConfidence,
  GitsVerifierRecommendation,
  GitsVerifierVerdict,
  IsoDateTime,
  PathString,
  SummaryString,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { AutomodeEpisodeLedgerRepositoryError } from "../Errors.ts";

export const AutomodeEpisode = Schema.Struct({
  id: TrimmedNonEmptyString,
  repo: PathString,
  goalId: TrimmedNonEmptyString,
  goalTitle: TrimmedNonEmptyString,
  sliceBranch: Schema.NullOr(TrimmedNonEmptyString),
  verdict: GitsVerifierVerdict,
  confidence: Schema.NullOr(GitsVerifierConfidence),
  recommendation: GitsVerifierRecommendation,
  flagged: Schema.Boolean,
  summary: SummaryString,
  review: GitsReviewResult,
  createdAt: IsoDateTime,
});
export type AutomodeEpisode = typeof AutomodeEpisode.Type;

export const ListAutomodeEpisodesInput = Schema.Struct({
  repo: Schema.optional(PathString),
  limit: Schema.optional(Schema.Number),
});
export type ListAutomodeEpisodesInput = typeof ListAutomodeEpisodesInput.Type;

export interface AutomodeEpisodeLedgerShape {
  readonly record_episode: (
    episode: AutomodeEpisode,
  ) => Effect.Effect<void, AutomodeEpisodeLedgerRepositoryError>;
  readonly list_episodes: (
    input: ListAutomodeEpisodesInput,
  ) => Effect.Effect<ReadonlyArray<AutomodeEpisode>, AutomodeEpisodeLedgerRepositoryError>;
}

export class AutomodeEpisodeLedger extends Context.Service<
  AutomodeEpisodeLedger,
  AutomodeEpisodeLedgerShape
>()("t3/persistence/Services/AutomodeEpisodeLedger") {}
```

> Verify `GitsVerifierVerdict`/`GitsVerifierConfidence`/`GitsVerifierRecommendation`, `PathString`, `SummaryString`, `TrimmedNonEmptyString`, `GitsReviewResult` are all exported from `@t3tools/contracts` (they are — `packages/contracts/src/gits.ts`). If any isn't re-exported from the package root, import from the same path the neighboring persistence services use.

- [ ] **Step 2: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/persistence/Services/AutomodeEpisodeLedger.ts && rtk git add apps/server/src/persistence/Services/AutomodeEpisodeLedger.ts && rtk git commit -m "feat(persistence): AutomodeEpisodeLedger service tag + record schema"
```

---

## Task 4: Ledger layer — insert + list

**Files:**
- Create: `apps/server/src/persistence/Layers/AutomodeEpisodeLedger.ts`
- Test: `apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `ProjectionThreadMessages.test.ts` harness)

```typescript
import {
  IsoDateTime,
  type AutomodeEpisode,
  type GitsReviewResult,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AutomodeEpisodeLedger } from "../Services/AutomodeEpisodeLedger.ts";
import { AutomodeEpisodeLedgerLive } from "./AutomodeEpisodeLedger.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const review: GitsReviewResult = {
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
    reasons: ["looks good"],
    missed: [],
    criteriaProvided: false,
    model: "gpt-5.5",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
  criteriaSource: "derived",
  summary: "verdict=pass",
  checkedAt: "2026-01-01T00:00:00.000Z",
};

function episode(overrides: Partial<AutomodeEpisode>): AutomodeEpisode {
  return {
    id: "ep-1",
    repo: "/tmp/source-repo",
    goalId: "goal-1",
    goalTitle: "Slice one",
    sliceBranch: "auto/slice/goal-1",
    verdict: "pass",
    confidence: "high",
    recommendation: "hold-for-review",
    flagged: false,
    summary: "verdict=pass",
    review,
    createdAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

const layer = it.layer(
  AutomodeEpisodeLedgerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("AutomodeEpisodeLedger", (it) => {
  it.effect("records an episode and lists it back with the review round-tripped", () =>
    Effect.gen(function* () {
      const ledger = yield* AutomodeEpisodeLedger;
      yield* ledger.record_episode(episode({}));
      const all = yield* ledger.list_episodes({});
      assert.equal(all.length, 1);
      assert.equal(all[0]?.goalTitle, "Slice one");
      assert.equal(all[0]?.verdict, "pass");
      assert.equal(all[0]?.review.semantic?.reasons[0], "looks good");
    }),
  );

  it.effect("filters by repo and returns newest-first", () =>
    Effect.gen(function* () {
      const ledger = yield* AutomodeEpisodeLedger;
      yield* ledger.record_episode(
        episode({ id: "ep-a", repo: "/repo/a", createdAt: "2026-01-01T00:00:01.000Z" }),
      );
      yield* ledger.record_episode(
        episode({ id: "ep-b", repo: "/repo/b", createdAt: "2026-01-01T00:00:02.000Z" }),
      );
      yield* ledger.record_episode(
        episode({ id: "ep-c", repo: "/repo/a", createdAt: "2026-01-01T00:00:03.000Z" }),
      );

      const repoA = yield* ledger.list_episodes({ repo: "/repo/a" });
      assert.deepEqual(
        repoA.map((e) => e.id),
        ["ep-c", "ep-a"],
      );
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts`
Expected: FAIL — `AutomodeEpisodeLedgerLive` not defined.

- [ ] **Step 3: Implement the layer** (mirror `Layers/ProviderSessionRuntime.ts`)

```typescript
import { AutomodeEpisode as AutomodeEpisodeSchema } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AutomodeEpisodeLedgerRepositoryError,
} from "../Errors.ts";
import {
  AutomodeEpisode,
  AutomodeEpisodeLedger,
  ListAutomodeEpisodesInput,
  type AutomodeEpisodeLedgerShape,
} from "../Services/AutomodeEpisodeLedger.ts";

// DB-row mapping: `review` stored as JSON TEXT, `flagged` as 0/1 INTEGER.
const AutomodeEpisodeDbRowSchema = AutomodeEpisode.mapFields(
  Struct.assign({
    review: Schema.fromJsonString(Schema.Unknown),
    flagged: Schema.transform(Schema.Number, Schema.Boolean, {
      decode: (n) => n !== 0,
      encode: (b) => (b ? 1 : 0),
    }),
  }),
);

const decodeEpisode = Schema.decodeUnknownEffect(AutomodeEpisode);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AutomodeEpisodeLedgerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const SELECT_COLUMNS = `
  id,
  repo,
  goal_id AS "goalId",
  goal_title AS "goalTitle",
  slice_branch AS "sliceBranch",
  verdict,
  confidence,
  recommendation,
  flagged,
  summary,
  review_json AS "review",
  created_at AS "createdAt"
`;

const makeAutomodeEpisodeLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEpisodeRow = SqlSchema.void({
    Request: AutomodeEpisodeDbRowSchema,
    execute: (episode) =>
      sql`
        INSERT INTO automode_episodes (
          id, repo, goal_id, goal_title, slice_branch,
          verdict, confidence, recommendation, flagged, summary,
          review_json, created_at
        )
        VALUES (
          ${episode.id}, ${episode.repo}, ${episode.goalId}, ${episode.goalTitle}, ${episode.sliceBranch},
          ${episode.verdict}, ${episode.confidence}, ${episode.recommendation}, ${episode.flagged}, ${episode.summary},
          ${episode.review}, ${episode.createdAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          repo = excluded.repo,
          goal_id = excluded.goal_id,
          goal_title = excluded.goal_title,
          slice_branch = excluded.slice_branch,
          verdict = excluded.verdict,
          confidence = excluded.confidence,
          recommendation = excluded.recommendation,
          flagged = excluded.flagged,
          summary = excluded.summary,
          review_json = excluded.review_json,
          created_at = excluded.created_at
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomodeEpisodeDbRowSchema,
    execute: () =>
      sql`SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM automode_episodes ORDER BY created_at DESC, id DESC`,
  });

  const listByRepoRows = SqlSchema.findAll({
    Request: Schema.Struct({ repo: AutomodeEpisode.fields.repo }),
    Result: AutomodeEpisodeDbRowSchema,
    execute: ({ repo }) =>
      sql`SELECT ${sql.unsafe(SELECT_COLUMNS)} FROM automode_episodes WHERE repo = ${repo} ORDER BY created_at DESC, id DESC`,
  });

  const record_episode: AutomodeEpisodeLedgerShape["record_episode"] = (episode) =>
    insertEpisodeRow(episode).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AutomodeEpisodeLedger.record_episode:query",
          "AutomodeEpisodeLedger.record_episode:encodeRequest",
        ),
      ),
    );

  const list_episodes: AutomodeEpisodeLedgerShape["list_episodes"] = (input) =>
    (input.repo === undefined ? listAllRows(undefined) : listByRepoRows({ repo: input.repo })).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AutomodeEpisodeLedger.list_episodes:query",
          "AutomodeEpisodeLedger.list_episodes:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeEpisode(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("AutomodeEpisodeLedger.list_episodes:rowToEpisode"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((episodes) =>
        input.limit === undefined ? episodes : episodes.slice(0, input.limit),
      ),
    );

  return { record_episode, list_episodes } satisfies AutomodeEpisodeLedgerShape;
});

export const AutomodeEpisodeLedgerLive = Layer.effect(
  AutomodeEpisodeLedger,
  makeAutomodeEpisodeLedger,
);
```

> Two things to verify against the installed Effect version while implementing:
> - **`sql.unsafe(...)` for the shared column list.** The neighbor repo inlines the `SELECT` columns literally in each query rather than interpolating. If `sql.unsafe` isn't available/idiomatic here, inline the `SELECT … AS "camelField"` column list directly in both queries (copy it verbatim into each), exactly like `Layers/ProviderSessionRuntime.ts` does. Prefer matching the neighbor: **inline the columns** if there's any doubt.
> - **`Schema.transform` signature** (positional vs `{ decode, encode }`). Match the form used elsewhere in `packages/contracts`/persistence. If `mapFields`+`transform` for `flagged` fights the row decode, fall back to storing/reading `flagged` as a plain `Schema.Number` column and converting in `record_episode`/after decode (keep the public `AutomodeEpisode.flagged` boolean).
> - The unused `AutomodeEpisodeSchema`/`ListAutomodeEpisodesInput` imports: drop any that lint flags as unused.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/persistence/Layers/AutomodeEpisodeLedger.ts apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts && rtk git add apps/server/src/persistence/Layers/AutomodeEpisodeLedger.ts apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts && rtk git commit -m "feat(persistence): AutomodeEpisodeLedger repository (record + list)"
```

---

## Task 5: Driver records an episode on the landed-slice path

**Files:**
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.ts`
- Modify: `apps/server/src/gits/Layers/AutomodeDriver.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the driver test harness (`makeLayer`) to provide an `AutomodeEpisodeLedger` mock that captures recorded episodes into a closure array, exposed via a new option `onRecordEpisode?: (e: AutomodeEpisode) => void`. The mock:

```typescript
const recordedEpisodes: AutomodeEpisode[] = [];
const ledger = Layer.mock(AutomodeEpisodeLedger)({
  record_episode: (e) =>
    Effect.sync(() => {
      recordedEpisodes.push(e);
      options?.onRecordEpisode?.(e);
    }),
  list_episodes: () => Effect.succeed([]),
});
```

and `Layer.provide(ledger)` on the returned driver layer. Then add:

```typescript
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
  }).pipe(
    Effect.provide(
      makeLayer(peerStatus, {
        review: passingReview,
        onRecordEpisode: (e) => episodes.push(e),
      }),
    ),
  );
});
```

(Import `AutomodeEpisode` type from `@t3tools/contracts` — or from the ledger service — in the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeDriver.test.ts`
Expected: FAIL — driver does not record episodes (and the `AutomodeEpisodeLedger` dep isn't required yet → layer/DI error).

- [ ] **Step 3: Implement in the driver**

Add the dep + import:

```typescript
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
```

```typescript
    const heldPr = yield* AutomodeHeldPr;
    const ledger = yield* AutomodeEpisodeLedger;
```

After the successful `completeGoal` + `logInfo("gits.automode.driver.goal-landed", …)` (driver done-path, before its `return`), record the episode. Build it from the in-scope `running` goal, `review`, and `decision`:

```typescript
            yield* supervisor.completeGoal({ goalId: running.id });
            const recordedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            yield* ledger
              .record_episode({
                id: `ep-${running.id}-${recordedAt}`,
                repo: running.repo,
                goalId: running.id,
                goalTitle: running.title,
                sliceBranch: peer.branch,
                verdict: review.semantic?.verdict ?? "uncertain",
                confidence: review.semantic?.confidence ?? null,
                recommendation: review.recommendation,
                flagged: decision.flagged,
                summary: review.summary,
                review,
                createdAt: recordedAt,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("gits.automode.ledger.record-failed", {
                    goalId: running.id,
                    error: error.message,
                  }),
                ),
              );
            yield* Effect.logInfo("gits.automode.driver.goal-landed", {
              goalId: running.id,
              peerId: peer.id,
              flagged: decision.flagged,
            });
            return;
```

Add `import * as DateTime from "effect/DateTime";` if not already imported in the driver. **Ledger-write failure must not halt the run** — it's wrapped in `Effect.catch` → `logWarning` (the slice already landed and the goal is complete; a ledger hiccup is non-fatal). `peer.branch` is `string | null` which matches `sliceBranch: Schema.NullOr(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/gits/Layers/AutomodeDriver.test.ts`
Expected: PASS (new + all existing driver cases — the existing landed-slice tests now also exercise the ledger mock, which defaults to a no-op record).

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts && rtk git add apps/server/src/gits/Layers/AutomodeDriver.ts apps/server/src/gits/Layers/AutomodeDriver.test.ts && rtk git commit -m "feat(automode): record an episode ledger entry on each landed slice"
```

---

## Task 6: Server layer wiring

**Files:**
- Modify: `apps/server/src/server.ts` (`AutomodeDriverLayerLive` block)

- [ ] **Step 1: Provide the ledger to the driver**

Import:

```typescript
import { AutomodeEpisodeLedgerLive } from "./persistence/Layers/AutomodeEpisodeLedger.ts";
```

The ledger needs `SqlClient`, which `PersistenceLayerLive` provides. Add to the `AutomodeDriverLayerLive` pipe (alongside the 3a/3b providers):

```typescript
const AutomodeEpisodeLedgerLayerLive = AutomodeEpisodeLedgerLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

const AutomodeDriverLayerLive = AutomodeDriverLive.pipe(
  Layer.provide(AutomodeSupervisorLayerLive),
  Layer.provide(DelamainCliAdapterLive),
  Layer.provide(AutomodeLandingLayerLive),
  Layer.provide(AutomodeHeldPrLayerLive),
  Layer.provide(AutomodeEpisodeLedgerLayerLive),
  Layer.provide(
    GitsReviewPipelineLive.pipe(
      Layer.provide(GitsCodexVerifierAdapterLive),
      Layer.provide(GitsSliceCriteriaStoreLive),
      Layer.provide(GitsConfinedVerifyAdapterLive),
    ),
  ),
);
```

> `PersistenceLayerLive` is already defined and imported in `server.ts` (it provides the shared `SqlClient`); Effect memoizes by reference so the same DB client is shared with the rest of the runtime. Verify the exact local name (`PersistenceLayerLive`).

- [ ] **Step 2: Typecheck (direct) + boot test**

```bash
PATH="$HOME/.local/bin:$PATH" cd apps/server && npx tsgo --noEmit   # expect 0
PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/server.test.ts apps/server/src/bin.test.ts
```

Expected: typecheck 0; boot tests PASS (the runtime layer builds — the driver's new `AutomodeEpisodeLedger` requirement is satisfied via `PersistenceLayerLive`, which is already in the runtime root).

- [ ] **Step 3: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun fmt apps/server/src/server.ts && rtk git add apps/server/src/server.ts && rtk git commit -m "feat(automode): wire AutomodeEpisodeLedger into the driver layer"
```

---

## Task 7: Full gate + held PR to `gits`

- [ ] **Step 1: Full gate**

```bash
PATH="$HOME/.local/bin:$PATH" rtk bun lint && rtk bun typecheck --force && rtk npx vitest run apps/server packages/contracts
```

Expected: lint 0 errors; typecheck 14/14 (exit 0); tests pass. (Known pre-existing flake unrelated to this work: `ProviderRegistry > re-probes when settings change the codex binaryPath` — time-based, passes in isolation; re-run that file alone if it trips under concurrency.)

- [ ] **Step 2: Targeted re-run**

```bash
PATH="$HOME/.local/bin:$PATH" rtk npx vitest run \
  apps/server/src/persistence/Layers/AutomodeEpisodeLedger.test.ts \
  apps/server/src/gits/Layers/AutomodeDriver.test.ts \
  apps/server/src/server.test.ts
```

- [ ] **Step 3: Push + open the held PR**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git push -u origin feat/automode-episode-ledger
PATH="$HOME/.local/bin:$PATH" rtk gh pr create --repo Ecko95/gitscode --base gits --head feat/automode-episode-ledger --title "feat(automode): Plan 4 — episode ledger (SQLite)" --body "Plan 4 of the autonomous-toggle roadmap. Persists a per-landed-slice episode (verifier verdict/confidence/reasons/misses + goal + review JSON) into state.sqlite (migration 032) and exposes record_episode/list_episodes for rehydrate. Driver writes one episode after each completeGoal. Plan: docs/superpowers/plans/2026-06-21-automode-episode-ledger.md"
```

> Note (`[[gitscode-no-ci-verify-locally]]`): PRs to `gits` trigger non-required GitHub Actions on **Blacksmith** runners; if those are still unavailable the check sits queued (`UNSTABLE` but `MERGEABLE`). Local gate is the source of truth until Blacksmith is restored.

---

## Self-Review (completed by plan author)

- **Spec coverage:** per-project SQLite episode ledger → Tasks 1/3/4 (shared `state.sqlite` + `repo` column; per-project file deferred with `stateDir` global until Plan 7). Verifier-output summary captured → Task 3 schema (`verdict`/`confidence`/`recommendation`/`flagged`/`summary` + full `review` JSON). Write trigger → Task 5 (driver after `completeGoal`). Rehydrate/read-back → Task 4 `list_episodes` (+ `repo` filter, newest-first). Wiring → Task 6.
- **Placeholder scan:** every code step has real code. The three "verify against installed Effect version" notes (Task 4: `sql.unsafe`, `Schema.transform` form) are inspect-then-match instructions with explicit fallbacks, not guesses.
- **Type consistency:** `AutomodeEpisode` / `AutomodeEpisodeLedger` / `record_episode` / `list_episodes` / `ListAutomodeEpisodesInput` (Task 3) used in Tasks 4–6. `AutomodeEpisodeLedgerRepositoryError` (Task 2) used in Tasks 3–4. Migration table/column names in Task 1 match the `SELECT … AS "camelField"` aliases and `INSERT` columns in Task 4. `review.semantic?.verdict`/`confidence`, `review.recommendation`, `review.summary`, `decision.flagged`, `running.repo`/`title`/`id`, `peer.branch` all match the live driver-scope types verified in `AutomodeDriver.ts` and `packages/contracts/src/gits.ts`.
- **v1 simplifications (documented):** episodes only on the success path (failed/halted goals aren't episodes); no PR url on the episode (per-run, joined via `repo` if needed); single shared DB with `repo` column (per-project partitioning is Plan 7); `id` is `ep-<goalId>-<iso>` (deterministic per goal-completion, upsert-safe).

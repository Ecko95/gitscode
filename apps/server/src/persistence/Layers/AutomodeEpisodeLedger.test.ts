import type { GitsReviewResult } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AutomodeEpisodeLedger, type AutomodeEpisode } from "../Services/AutomodeEpisodeLedger.ts";
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

const layer = it.layer(AutomodeEpisodeLedgerLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("AutomodeEpisodeLedger", (it) => {
  it.effect("records an episode and lists it back with the review round-tripped", () =>
    Effect.gen(function* () {
      const ledger = yield* AutomodeEpisodeLedger;
      yield* ledger.record_episode(episode({}));
      const all = yield* ledger.list_episodes({});
      assert.equal(all.length, 1);
      assert.equal(all[0]?.goalTitle, "Slice one");
      assert.equal(all[0]?.verdict, "pass");
      assert.equal(all[0]?.flagged, false);
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

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const usagePayload = (model: string, costUSD: number) =>
  JSON.stringify({
    state: "completed",
    totalCostUsd: costUSD,
    modelUsage: {
      [model]: {
        inputTokens: 10,
        outputTokens: 100,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 0,
        costUSD,
      },
    },
  });

const contextWindowPayload = JSON.stringify({ usedTokens: 1 });

layer("ProjectionSnapshotQuery.getUsageModelBreakdown", (it) => {
  it.effect("aggregates usage.cost.updated activities within the requested window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionSnapshotQuery;

      const now = yield* DateTime.now;
      const iso = (minutesAgo: number) =>
        DateTime.formatIso(DateTime.subtract(now, { minutes: minutesAgo }));

      const seedActivity = (input: {
        activityId: string;
        threadId: string;
        turnId: string;
        kind: string;
        payloadJson: string;
        createdAt: string;
      }) =>
        sql`
          INSERT INTO projection_thread_activities
            (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
          VALUES
            (${input.activityId}, ${input.threadId}, ${input.turnId}, 'info', ${input.kind},
             'Usage cost updated', ${input.payloadJson}, ${input.createdAt})
        `;

      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, provider_name, updated_at)
        VALUES ('thread-claude', 'ready', 'claudeAgent', ${iso(1)}),
               ('thread-codex', 'ready', 'codex', ${iso(1)})
      `;

      // Two in the 5h window (distinct turns), one only in the weekly window,
      // one outside both, and one non-usage activity that must be ignored.
      yield* seedActivity({
        activityId: "activity-recent-1",
        threadId: "thread-claude",
        turnId: "turn-1",
        kind: "usage.cost.updated",
        payloadJson: usagePayload("claude-opus-4-8", 0.1),
        createdAt: iso(10),
      });
      yield* seedActivity({
        activityId: "activity-recent-2",
        threadId: "thread-claude",
        turnId: "turn-2",
        kind: "usage.cost.updated",
        payloadJson: usagePayload("claude-opus-4-8", 0.2),
        createdAt: iso(200),
      });
      yield* seedActivity({
        activityId: "activity-weekly",
        threadId: "thread-codex",
        turnId: "turn-3",
        kind: "usage.cost.updated",
        payloadJson: usagePayload("gpt-5.5", 0.05),
        createdAt: iso(60 * 24),
      });
      yield* seedActivity({
        activityId: "activity-ancient",
        threadId: "thread-claude",
        turnId: "turn-4",
        kind: "usage.cost.updated",
        payloadJson: usagePayload("claude-opus-4-8", 99),
        createdAt: iso(60 * 24 * 8),
      });
      yield* seedActivity({
        activityId: "activity-other-kind",
        threadId: "thread-claude",
        turnId: "turn-1",
        kind: "context-window.updated",
        payloadJson: contextWindowPayload,
        createdAt: iso(1),
      });

      const getUsageModelBreakdown = query.getUsageModelBreakdown;
      assert.isDefined(getUsageModelBreakdown);
      if (!getUsageModelBreakdown) return;

      const fiveHour = yield* getUsageModelBreakdown({ window: "fiveHour" });
      assert.equal(fiveHour.window, "fiveHour");
      assert.equal(fiveHour.entries.length, 1);
      assert.equal(fiveHour.entries[0]?.model, "claude-opus-4-8");
      assert.equal(fiveHour.entries[0]?.provider, "claude");
      assert.equal(fiveHour.entries[0]?.turns, 2);
      assert.equal(fiveHour.entries[0]?.inputTokens, 20);
      assert.equal(fiveHour.entries[0]?.cachedInputTokens, 2000);
      assert.equal(fiveHour.entries[0]?.outputTokens, 200);
      assert.approximately(fiveHour.entries[0]?.estCostUsd ?? 0, 0.3, 1e-9);

      const weekly = yield* getUsageModelBreakdown({ window: "weekly" });
      assert.equal(weekly.entries.length, 2);
      const codexEntry = weekly.entries.find((entry) => entry.provider === "codex");
      assert.equal(codexEntry?.model, "gpt-5.5");
      assert.equal(codexEntry?.turns, 1);
      const claudeEntry = weekly.entries.find((entry) => entry.provider === "claude");
      assert.approximately(claudeEntry?.estCostUsd ?? 0, 0.3, 1e-9);
    }),
  );
});

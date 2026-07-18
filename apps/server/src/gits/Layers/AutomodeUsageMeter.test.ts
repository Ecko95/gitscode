import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeUsageMeterLive } from "./AutomodeUsageMeter.ts";

const meterLayer = () => AutomodeUsageMeterLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

function insertActivity(
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly threadId: string;
    readonly kind: string;
    readonly createdAt: string;
    readonly payload: unknown;
  },
) {
  return sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    )
    VALUES (
      ${input.id}, ${input.threadId}, NULL, 'info', ${input.kind}, ${input.kind},
      ${JSON.stringify(input.payload)}, ${input.createdAt}
    )
  `;
}

describe("AutomodeUsageMeterLive", () => {
  // Equivalence: these expected values are exactly what the old getSnapshot-derived
  // path produced for this seed (per-thread MAX cost/tokens, summed across threads).
  it.effect("sums latest per-thread provider costs and context tokens from the SQL aggregate", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertActivity(sql, {
        id: "cost-a-old",
        threadId: "thread-a",
        kind: "usage.cost.updated",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { totalCostUsd: 0.25 },
      });
      yield* insertActivity(sql, {
        id: "cost-a-new",
        threadId: "thread-a",
        kind: "usage.cost.updated",
        createdAt: "2026-01-01T00:01:00.000Z",
        payload: { totalCostUsd: 0.4 },
      });
      yield* insertActivity(sql, {
        id: "tokens-a",
        threadId: "thread-a",
        kind: "context-window.updated",
        createdAt: "2026-01-01T00:03:00.000Z",
        payload: { usedTokens: 120, totalProcessedTokens: 140 },
      });
      yield* insertActivity(sql, {
        id: "cost-b",
        threadId: "thread-b",
        kind: "usage.cost.updated",
        createdAt: "2026-01-01T00:02:00.000Z",
        payload: { totalCostUsd: 1.1 },
      });
      yield* insertActivity(sql, {
        id: "tokens-b",
        threadId: "thread-b",
        kind: "context-window.updated",
        createdAt: "2026-01-01T00:02:30.000Z",
        payload: { usedTokens: 20 },
      });

      const usage = yield* (yield* AutomodeUsageMeter).readBudgetUsage();

      assert.equal(usage.source, "provider-runtime");
      assert.equal(usage.totalCostUsd, 1.5);
      assert.equal(usage.totalProcessedTokens, 160);
      assert.equal(usage.updatedAt, "2026-01-01T00:03:00.000Z");
      assert.equal(usage.note, null);
    }).pipe(Effect.provide(meterLayer())),
  );

  it.effect("reports unavailable when no provider usage activities exist", () =>
    Effect.gen(function* () {
      const usage = yield* (yield* AutomodeUsageMeter).readBudgetUsage();

      assert.equal(usage.source, "unavailable");
      assert.equal(usage.totalCostUsd, null);
      assert.equal(usage.totalProcessedTokens, null);
      assert.equal(usage.updatedAt, null);
      assert.match(usage.note ?? "", /No provider cost events observed/);
    }).pipe(Effect.provide(meterLayer())),
  );

  // Memo: a second read inside the 60s window must not observe rows inserted after
  // the first read populated the cache.
  it.effect("memoizes the budget usage within the TTL window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const meter = yield* AutomodeUsageMeter;

      yield* insertActivity(sql, {
        id: "cost-1",
        threadId: "thread-a",
        kind: "usage.cost.updated",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { totalCostUsd: 1 },
      });
      const first = yield* meter.readBudgetUsage();
      assert.equal(first.totalCostUsd, 1);

      yield* insertActivity(sql, {
        id: "cost-2",
        threadId: "thread-b",
        kind: "usage.cost.updated",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { totalCostUsd: 5 },
      });
      const second = yield* meter.readBudgetUsage();
      assert.equal(second.totalCostUsd, 1);
    }).pipe(Effect.provide(meterLayer())),
  );
});

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { AutomodeSupervisorError, type AutomodeBudgetUsage } from "@t3tools/contracts";

import {
  AutomodeUsageMeter,
  type AutomodeUsageMeterShape,
} from "../Services/AutomodeUsageMeter.ts";

// ponytail: 60s memo — automode budget checks tolerate one window of staleness.
// Overshoot ceiling: automode can exceed maxBudgetUsd by at most one 60s window of
// spend (the memo lag). Tighten TTL if that window ever matters for a hard cap.
const USAGE_MEMO_TTL_MS = 60_000;

function toAutomodeUsageError(message: string, cause?: unknown) {
  return new AutomodeSupervisorError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function costFromActivity(kind: string, payload: unknown): number | null {
  if (kind !== "usage.cost.updated") {
    return null;
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  return nonNegativeNumber(record.totalCostUsd);
}

function processedTokensFromActivity(kind: string, payload: unknown): number | null {
  if (kind !== "context-window.updated") {
    return null;
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  return nonNegativeInteger(record.totalProcessedTokens) ?? nonNegativeInteger(record.usedTokens);
}

function latestIso(left: string | null, right: string): string {
  return left === null || right.localeCompare(left) > 0 ? right : left;
}

const ProviderUsageActivityRow = Schema.Struct({
  threadId: Schema.String,
  kind: Schema.String,
  payload: Schema.fromJsonString(Schema.Unknown),
  createdAt: Schema.String,
});

export const AutomodeUsageMeterLive = Layer.effect(
  AutomodeUsageMeter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memoRef = yield* Ref.make<{ readonly at: number; readonly usage: AutomodeBudgetUsage } | null>(
      null,
    );

    // ponytail: filter to the two provider-usage kinds in SQL, reduce in JS with the
    // exact same helpers the old snapshot path used — guarantees byte-identical budget
    // numbers (billing correctness) without replicating JS number semantics
    // (non-negative/finite/integer, totalProcessedTokens-else-usedTokens) in SQL/JSON.
    // Replaces ProjectionSnapshotQuery.getSnapshot() (10 findAll + full read-model decode).
    const listProviderUsageActivityRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ProviderUsageActivityRow,
      execute: () =>
        sql`
          SELECT
            thread_id AS "threadId",
            kind,
            payload_json AS "payload",
            created_at AS "createdAt"
          FROM projection_thread_activities
          WHERE kind IN ('usage.cost.updated', 'context-window.updated')
        `,
    });

    const meter: AutomodeUsageMeterShape = {
      readBudgetUsage: () =>
        Effect.gen(function* () {
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const memo = yield* Ref.get(memoRef);
          if (memo !== null && nowMs - memo.at < USAGE_MEMO_TTL_MS) {
            return memo.usage;
          }

          const rows = yield* listProviderUsageActivityRows(undefined).pipe(
            Effect.mapError((cause) =>
              toAutomodeUsageError(
                "Failed to read provider usage for automode budget checks.",
                cause,
              ),
            ),
          );

          const costByThread = new Map<string, number>();
          const tokensByThread = new Map<string, number>();
          let updatedAt: string | null = null;

          for (const row of rows) {
            const costUsd = costFromActivity(row.kind, row.payload);
            if (costUsd !== null) {
              costByThread.set(row.threadId, Math.max(costByThread.get(row.threadId) ?? 0, costUsd));
              updatedAt = latestIso(updatedAt, row.createdAt);
            }

            const processedTokens = processedTokensFromActivity(row.kind, row.payload);
            if (processedTokens !== null) {
              tokensByThread.set(
                row.threadId,
                Math.max(tokensByThread.get(row.threadId) ?? 0, processedTokens),
              );
              updatedAt = latestIso(updatedAt, row.createdAt);
            }
          }

          const totalCostUsd =
            costByThread.size === 0
              ? null
              : [...costByThread.values()].reduce((total, cost) => total + cost, 0);
          const totalProcessedTokens =
            tokensByThread.size === 0
              ? null
              : [...tokensByThread.values()].reduce((total, tokens) => total + tokens, 0);

          const usage: AutomodeBudgetUsage = {
            source:
              totalCostUsd !== null || totalProcessedTokens !== null
                ? "provider-runtime"
                : "unavailable",
            totalCostUsd,
            totalProcessedTokens,
            updatedAt,
            note:
              totalCostUsd === null
                ? "No provider cost events observed. Automode USD budgets remain locked when a budget is configured."
                : null,
          };

          yield* Ref.set(memoRef, { at: nowMs, usage });
          return usage;
        }),
    };

    return meter;
  }),
);

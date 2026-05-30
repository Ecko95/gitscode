import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AutomodeSupervisorError, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AutomodeUsageMeter,
  type AutomodeUsageMeterShape,
} from "../Services/AutomodeUsageMeter.ts";

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

function costFromActivity(activity: OrchestrationThreadActivity): number | null {
  if (activity.kind !== "usage.cost.updated") {
    return null;
  }

  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }
  return nonNegativeNumber(payload.totalCostUsd);
}

function processedTokensFromActivity(activity: OrchestrationThreadActivity): number | null {
  if (activity.kind !== "context-window.updated") {
    return null;
  }

  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  return nonNegativeInteger(payload.totalProcessedTokens) ?? nonNegativeInteger(payload.usedTokens);
}

function latestIso(left: string | null, right: string): string {
  return left === null || right.localeCompare(left) > 0 ? right : left;
}

export const AutomodeUsageMeterLive = Layer.effect(
  AutomodeUsageMeter,
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const meter: AutomodeUsageMeterShape = {
      readBudgetUsage: () =>
        Effect.gen(function* () {
          const snapshot = yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
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

          for (const thread of snapshot.threads) {
            for (const activity of thread.activities) {
              const costUsd = costFromActivity(activity);
              if (costUsd !== null) {
                const existing = costByThread.get(thread.id) ?? 0;
                costByThread.set(thread.id, Math.max(existing, costUsd));
                updatedAt = latestIso(updatedAt, activity.createdAt);
              }

              const processedTokens = processedTokensFromActivity(activity);
              if (processedTokens !== null) {
                const existing = tokensByThread.get(thread.id) ?? 0;
                tokensByThread.set(thread.id, Math.max(existing, processedTokens));
                updatedAt = latestIso(updatedAt, activity.createdAt);
              }
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

          return {
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
        }),
    };

    return meter;
  }),
);

import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationReadModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeUsageMeterLive } from "./AutomodeUsageMeter.ts";

function makeReadModel(threads: ReadonlyArray<unknown>): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads,
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as OrchestrationReadModel;
}

function makeThread(id: string, activities: ReadonlyArray<unknown>) {
  return {
    id,
    activities,
  };
}

function makeActivity(input: {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly payload: unknown;
}) {
  return {
    id: input.id,
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: input.payload,
    turnId: null,
    createdAt: input.createdAt,
  };
}

function makeProjectionLayer(readModel: OrchestrationReadModel) {
  const unsupported = () => Effect.die(new Error("AutomodeUsageMeter should only read snapshots"));
  return Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: unsupported,
    getSnapshot: () => Effect.succeed(readModel),
    getShellSnapshot: unsupported,
    getArchivedShellSnapshot: unsupported,
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: readModel.snapshotSequence }),
    getCounts: () =>
      Effect.succeed({
        projectCount: readModel.projects.length,
        threadCount: readModel.threads.length,
      }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailById: () => Effect.succeed(Option.none()),
  });
}

describe("AutomodeUsageMeterLive", () => {
  it.effect("sums latest per-thread provider costs and context tokens", () =>
    Effect.gen(function* () {
      const usageMeter = yield* AutomodeUsageMeter;
      const usage = yield* usageMeter.readBudgetUsage();

      assert.equal(usage.source, "provider-runtime");
      assert.equal(usage.totalCostUsd, 1.5);
      assert.equal(usage.totalProcessedTokens, 160);
      assert.equal(usage.updatedAt, "2026-01-01T00:03:00.000Z");
      assert.equal(usage.note, null);
    }).pipe(
      Effect.provide(
        AutomodeUsageMeterLive.pipe(
          Layer.provide(
            makeProjectionLayer(
              makeReadModel([
                makeThread("thread-a", [
                  makeActivity({
                    id: "cost-a-old",
                    kind: "usage.cost.updated",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    payload: { totalCostUsd: 0.25 },
                  }),
                  makeActivity({
                    id: "cost-a-new",
                    kind: "usage.cost.updated",
                    createdAt: "2026-01-01T00:01:00.000Z",
                    payload: { totalCostUsd: 0.4 },
                  }),
                  makeActivity({
                    id: "tokens-a",
                    kind: "context-window.updated",
                    createdAt: "2026-01-01T00:03:00.000Z",
                    payload: { usedTokens: 120, totalProcessedTokens: 140 },
                  }),
                ]),
                makeThread("thread-b", [
                  makeActivity({
                    id: "cost-b",
                    kind: "usage.cost.updated",
                    createdAt: "2026-01-01T00:02:00.000Z",
                    payload: { totalCostUsd: 1.1 },
                  }),
                  makeActivity({
                    id: "tokens-b",
                    kind: "context-window.updated",
                    createdAt: "2026-01-01T00:02:30.000Z",
                    payload: { usedTokens: 20 },
                  }),
                ]),
              ]),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("reports unavailable when no provider usage activities exist", () =>
    Effect.gen(function* () {
      const usageMeter = yield* AutomodeUsageMeter;
      const usage = yield* usageMeter.readBudgetUsage();

      assert.equal(usage.source, "unavailable");
      assert.equal(usage.totalCostUsd, null);
      assert.equal(usage.totalProcessedTokens, null);
      assert.equal(usage.updatedAt, null);
      assert.match(usage.note ?? "", /No provider cost events observed/);
    }).pipe(
      Effect.provide(
        AutomodeUsageMeterLive.pipe(
          Layer.provide(makeProjectionLayer(makeReadModel([makeThread("thread-empty", [])]))),
        ),
      ),
    ),
  );
});

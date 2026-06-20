/**
 * Shared visual-plan write path.
 *
 * Both the native MCP endpoint (agent write path) and the `gits.visualPlan.mutate`
 * WS RPC (web write path) merge changes into the current plan and round-trip a
 * `thread.visual-plan.upsert` command. Centralising the load + upsert here keeps
 * the `VisualPlanMcpRegistry` cache coherent across both paths — otherwise a web
 * mutation would update the projection but leave the agent's cached plan stale,
 * so `get-plan-feedback` would miss the reviewer's new comments.
 */
import { randomUUID } from "node:crypto";
import {
  applyPlanPatches,
  CommandId,
  exportPlanToMarkdown,
  type OrchestrationVisualPlan,
  type PlanComment,
  type PlanCommentDraft,
  resolvePlanComment,
  type ThreadId,
  upsertPlanComment,
  VisualPlanMutateError,
  type VisualPlanMutateInput,
  type VisualPlanMutateResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  getVisualPlanState,
  setVisualPlanState,
  type VisualPlanState,
} from "./VisualPlanMcpRegistry.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isVisualPlanMutateError = Schema.is(VisualPlanMutateError);

/** Load the current plan state from cache, falling back to the read model. */
export const loadVisualPlanState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const cached = getVisualPlanState(threadId);
    if (cached) {
      return Option.some(cached);
    }
    const snapshot = yield* ProjectionSnapshotQuery;
    const detail = yield* snapshot
      .getThreadDetailById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(detail)) {
      return Option.none<VisualPlanState>();
    }
    const plans = detail.value.visualPlans;
    const latest = plans.length > 0 ? plans[plans.length - 1] : undefined;
    if (!latest) {
      return Option.none<VisualPlanState>();
    }
    return Option.some<VisualPlanState>({
      planId: latest.id,
      content: latest.content,
      comments: latest.comments,
      createdAt: latest.createdAt,
    });
  });

/** Dispatch `thread.visual-plan.upsert` and refresh the registry cache. */
export const upsertVisualPlanState = (threadId: ThreadId, next: VisualPlanState) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const at = yield* nowIso;
    const visualPlan: OrchestrationVisualPlan = {
      id: next.planId,
      turnId: null,
      content: next.content,
      comments: next.comments,
      createdAt: next.createdAt,
      updatedAt: at,
    };
    yield* engine.dispatch({
      type: "thread.visual-plan.upsert",
      commandId: CommandId.make(`visual-plan:${threadId}:${randomUUID()}`),
      threadId,
      visualPlan,
      createdAt: at,
    });
    setVisualPlanState(threadId, next);
    return visualPlan;
  });

const mintComment = (draft: PlanCommentDraft) =>
  Effect.map(
    nowIso,
    (at): PlanComment => ({
      id: draft.id ?? `cmt_${randomUUID()}`,
      ...(draft.parentCommentId !== undefined ? { parentCommentId: draft.parentCommentId } : {}),
      anchor: draft.anchor,
      message: draft.message,
      createdBy: draft.createdBy ?? "human",
      ...(draft.resolutionTarget !== undefined ? { resolutionTarget: draft.resolutionTarget } : {}),
      createdAt: at,
      updatedAt: at,
    }),
  );

/**
 * Apply the web write-path mutation: content patches, then an optional new
 * comment, then an optional comment resolution; round-trip the upsert; return
 * the new plan plus its markdown export (for "send to agent").
 */
export const mutateVisualPlan = (
  input: VisualPlanMutateInput,
): Effect.Effect<
  VisualPlanMutateResult,
  VisualPlanMutateError,
  OrchestrationEngineService | ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    const existing = yield* loadVisualPlanState(input.threadId);
    if (Option.isNone(existing)) {
      return yield* new VisualPlanMutateError({
        message: "No visual plan exists for this thread. Ask the agent to render one first.",
      });
    }

    let state = existing.value;
    if (input.contentPatches && input.contentPatches.length > 0) {
      state = { ...state, content: applyPlanPatches(state.content, input.contentPatches) };
    }
    if (input.addComment) {
      const comment = yield* mintComment(input.addComment);
      state = { ...state, comments: upsertPlanComment(state.comments, comment) };
    }
    if (input.resolveCommentId) {
      const at = yield* nowIso;
      state = {
        ...state,
        comments: resolvePlanComment(state.comments, input.resolveCommentId, at),
      };
    }

    const visualPlan = yield* upsertVisualPlanState(input.threadId, state);
    return {
      visualPlan,
      exportMarkdown: exportPlanToMarkdown(visualPlan.content, visualPlan.comments),
    } satisfies VisualPlanMutateResult;
  }).pipe(
    Effect.catch((cause) =>
      isVisualPlanMutateError(cause)
        ? Effect.fail(cause)
        : Effect.fail(
            new VisualPlanMutateError({ message: "Failed to mutate visual plan.", cause }),
          ),
    ),
  );

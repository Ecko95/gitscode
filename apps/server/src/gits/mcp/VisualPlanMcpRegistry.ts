/**
 * Visual-plan MCP token service and plan-state cache.
 *
 * `VisualPlanMcpService` issues per-thread bearer tokens through
 * `AuthControlPlane` (role:"thread-scoped", subject:threadId) so they are
 * revocable, DB-backed, and visible to the auth control plane. It subscribes
 * to `thread.deleted` domain events and revokes the token automatically when
 * the thread ends — no reactor edits required.
 *
 * `getVisualPlanState`/`setVisualPlanState` remain module-level for plan-content
 * cache coherence (shared by both the MCP route and the WS mutate path).
 */
import type {
  AuthSessionId,
  OrchestrationEvent,
  PlanComment,
  PlanContent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { AuthControlPlane } from "../../auth/Services/AuthControlPlane.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";

/** HTTP path of the native visual-plan MCP endpoint. */
export const VISUAL_PLAN_MCP_PATH = "/api/gits/visual-plan/mcp";

export interface VisualPlanState {
  readonly planId: string;
  readonly content: PlanContent;
  readonly comments: ReadonlyArray<PlanComment>;
  readonly createdAt: string;
}

// ponytail: module-level plan cache (not auth) — shared across the MCP + WS write paths
const threadState = new Map<string, VisualPlanState>();

export function getVisualPlanState(threadId: ThreadId): VisualPlanState | undefined {
  return threadState.get(threadId);
}

export function setVisualPlanState(threadId: ThreadId, state: VisualPlanState): void {
  threadState.set(threadId, state);
}

// Backstop TTL; thread.deleted event triggers eager revocation before this expires.
const VISUAL_PLAN_TOKEN_TTL = Duration.hours(12);

export interface VisualPlanMcpServiceShape {
  /** Issue (or reuse) a bearer token for `threadId`. Returns the raw token string. */
  readonly issueToken: (threadId: ThreadId) => Effect.Effect<string>;
  /** Revoke the token for `threadId` if one was issued. */
  readonly revokeByThread: (threadId: ThreadId) => Effect.Effect<void>;
}

export class VisualPlanMcpService extends Context.Service<
  VisualPlanMcpService,
  VisualPlanMcpServiceShape
>()("t3/gits/mcp/VisualPlanMcpRegistry/VisualPlanMcpService") {}

const make = Effect.gen(function* () {
  const authControlPlane = yield* AuthControlPlane;
  const orchestrationEngine = yield* OrchestrationEngineService;

  // threadId → { token, sessionId } — token reuse keeps provider re-starts idempotent
  const sessionsByThread = yield* Ref.make(
    new Map<string, { readonly token: string; readonly sessionId: AuthSessionId }>(),
  );

  const issueToken: VisualPlanMcpServiceShape["issueToken"] = (threadId) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(sessionsByThread)).get(threadId);
      if (existing) {
        return existing.token;
      }
      const issued = yield* authControlPlane.issueSession({
        role: "thread-scoped",
        subject: threadId,
        label: `visual-plan MCP ${threadId}`,
        ttl: VISUAL_PLAN_TOKEN_TTL,
      });
      yield* Ref.update(sessionsByThread, (m) => {
        const next = new Map(m);
        next.set(threadId, { token: issued.token, sessionId: issued.sessionId });
        return next;
      });
      return issued.token;
      // ponytail: auth control plane failures become defects — they're infrastructure errors
    }).pipe(Effect.orDie);

  const revokeByThread: VisualPlanMcpServiceShape["revokeByThread"] = (threadId) =>
    Effect.gen(function* () {
      const entry = (yield* Ref.get(sessionsByThread)).get(threadId);
      if (!entry) return;
      yield* Ref.update(sessionsByThread, (m) => {
        const next = new Map(m);
        next.delete(threadId);
        return next;
      });
      yield* authControlPlane.revokeSession(entry.sessionId).pipe(Effect.ignore);
    });

  // Subscribe to thread-deletion events in a scoped fiber; Layer.effect's scope
  // interrupts the fiber when the service scope closes.
  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) => {
      if (event.type !== "thread.deleted") {
        return Effect.void;
      }
      return revokeByThread(event.payload.threadId).pipe(Effect.catchCause(() => Effect.void));
    }),
  );

  return { issueToken, revokeByThread } satisfies VisualPlanMcpServiceShape;
});

export const VisualPlanMcpServiceLive = Layer.effect(VisualPlanMcpService, make);

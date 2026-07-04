import {
  type ClientOrchestrationCommand,
  CommandId,
  CritTurnRequest,
  type CritTurnResponse,
  type CritTurnStatusResponse,
  MessageId,
  type OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { normalizeDispatchCommand } from "../orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Tagged error for the crit thread-scoped HTTP endpoints. `status` mirrors the
 * HTTP status the `respondToCritHttpError` mapper emits; it defaults to 500.
 */
export class CritHttpError extends Data.TaggedError("CritHttpError")<{
  readonly message: string;
  readonly status?: 400 | 403 | 404 | 500;
  readonly cause?: unknown;
}> {}

/**
 * Map a crit endpoint failure to an HTTP response. Mirrors
 * `respondToOrchestrationHttpError` / `respondToAuthError`:
 * - `AuthError` (from `authenticateHttpRequest`) keeps its own status (401).
 * - `CritHttpError` uses its `status` (403 subject mismatch, 400 invalid body,
 *   404 unknown thread, 500 projection failure).
 */
const respondToCritHttpError = (error: AuthError | CritHttpError) =>
  Effect.gen(function* () {
    const status = error.status ?? 500;
    if (status >= 500) {
      yield* Effect.logError("crit http route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status });
  });

/**
 * Authenticate the request and require `session.subject === threadId`. The
 * subject binding *is* the capability here, so role is deliberately not checked
 * (see the crit dedicated-endpoint design). A mismatch fails with a 403
 * `CritHttpError`; an authentication failure surfaces as the `AuthError`'s own
 * status (401).
 */
const authorize = (threadId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.subject !== threadId) {
      return yield* new CritHttpError({
        message: "Session is not authorized for this thread.",
        status: 403,
      });
    }
    return session;
  });

/**
 * Pure turn-status resolver. Given the caller's current thread snapshot and the
 * baseline `priorTurnId` captured at turn start, classify the started turn's
 * state relative to that baseline. Kept pure so every race branch is unit
 * testable without an HTTP boundary.
 */
export const compute_turn_status = (
  thread: OrchestrationThread,
  priorTurnId: string | null,
): CritTurnStatusResponse => {
  const latestTurn = thread.latestTurn;

  if (latestTurn === null || latestTurn.turnId === priorTurnId || latestTurn.state === "running") {
    return { state: "pending", assistantMessageId: null, reply: null };
  }

  if (latestTurn.state === "completed") {
    const assistantMessageId = latestTurn.assistantMessageId;
    const message =
      assistantMessageId !== null
        ? thread.messages.find((candidate) => candidate.id === assistantMessageId)
        : undefined;
    if (assistantMessageId === null || message === undefined) {
      // Turn completed but the assistant message has not projected yet.
      return { state: "pending", assistantMessageId: null, reply: null };
    }
    return { state: "completed", assistantMessageId, reply: message.text };
  }

  if (latestTurn.state === "error") {
    return { state: "error", assistantMessageId: null, reply: null };
  }

  // "interrupted" or any other terminal state.
  return { state: "interrupted", assistantMessageId: null, reply: null };
};

/**
 * Decode a raw `threadId` query parameter into a branded `ThreadId` without
 * throwing. `ThreadId.make(...)` runs the schema check synchronously and throws
 * a defect for empty/whitespace-only input — which `Effect.catchTags` would NOT
 * catch, surfacing as a 500 *before* `authorize` runs. Decoding through the
 * Effect error channel keeps the failure as a clean 400 instead.
 */
const decodeThreadIdParam = Schema.decodeUnknownEffect(ThreadId);

const buildTurnStartCommand = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const commandUuid = yield* crypto.randomUUIDv4;
    const messageUuid = yield* crypto.randomUUIDv4;
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    return {
      type: "thread.turn.start",
      commandId: CommandId.make(commandUuid),
      threadId,
      message: {
        messageId: MessageId.make(messageUuid),
        role: "user",
        text,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    } satisfies ClientOrchestrationCommand;
  });

export const critTurnRouteLayer = HttpRouter.add(
  "POST",
  "/api/crit/turn",
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(CritTurnRequest).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Invalid crit turn payload.",
            status: 400,
            cause,
          }),
      ),
    );

    const session = yield* authorize(body.threadId);

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(body.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Failed to load thread detail.",
            status: 500,
            cause,
          }),
      ),
    );
    if (Option.isNone(threadOption)) {
      return yield* new CritHttpError({
        message: "Thread not found.",
        status: 404,
      });
    }
    const thread = threadOption.value;
    const priorTurnId = thread.latestTurn?.turnId ?? null;

    const command = yield* buildTurnStartCommand(body.threadId, body.text).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Failed to build crit turn command.",
            status: 500,
            cause,
          }),
      ),
    );
    const normalizedCommand = yield* normalizeDispatchCommand(command).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Failed to normalize crit turn command.",
            status: 500,
            cause,
          }),
      ),
    );
    yield* orchestrationEngine.dispatch(normalizedCommand, "delamain", session.role).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Failed to dispatch crit turn command.",
            status: 500,
            cause,
          }),
      ),
    );

    return HttpServerResponse.jsonUnsafe({ priorTurnId } satisfies CritTurnResponse, {
      status: 200,
    });
  }).pipe(
    Effect.catchTags({
      AuthError: respondToCritHttpError,
      CritHttpError: respondToCritHttpError,
    }),
  ),
);

export const critTurnStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/crit/turn-status",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return yield* new CritHttpError({
        message: "Invalid request URL.",
        status: 400,
      });
    }
    const threadIdParam = url.value.searchParams.get("threadId");
    if (threadIdParam === null) {
      return yield* new CritHttpError({
        message: "threadId query parameter is required.",
        status: 400,
      });
    }
    const threadId = yield* decodeThreadIdParam(threadIdParam).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Invalid threadId query parameter.",
            status: 400,
            cause,
          }),
      ),
    );
    const priorTurnId = url.value.searchParams.get("priorTurnId");

    yield* authorize(threadId);

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const threadOption = yield* projectionSnapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new CritHttpError({
            message: "Failed to load thread detail.",
            status: 500,
            cause,
          }),
      ),
    );
    if (Option.isNone(threadOption)) {
      return yield* new CritHttpError({
        message: "Thread not found.",
        status: 404,
      });
    }

    return HttpServerResponse.jsonUnsafe(
      compute_turn_status(threadOption.value, priorTurnId ?? null) satisfies CritTurnStatusResponse,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTags({
      AuthError: respondToCritHttpError,
      CritHttpError: respondToCritHttpError,
    }),
  ),
);

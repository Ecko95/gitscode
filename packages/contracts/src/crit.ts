import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

/**
 * Client request to ensure a crit review sidecar is running for a
 * workspace+thread. The server-side handler assembles the full sidecar spawn
 * input (origin, scoped token, wrapper command, binary path) from this small
 * request — clients only supply the workspace coordinates.
 */
export const CritEnsureSidecarRequest = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type CritEnsureSidecarRequest = typeof CritEnsureSidecarRequest.Type;

/** Client request to read the current status of a workspace's crit sidecar. */
export const CritSidecarStatusRequest = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
});
export type CritSidecarStatusRequest = typeof CritSidecarStatusRequest.Type;

export const CritSidecarStatus = Schema.Literals(["starting", "ready", "crashed", "stopped"]);
export type CritSidecarStatus = typeof CritSidecarStatus.Type;

/**
 * Shared response for both ensureSidecar and sidecarStatus: the sidecar's
 * lifecycle status and (once it has a port) its loopback URL.
 */
export const CritSidecarStatusResponse = Schema.Struct({
  status: CritSidecarStatus,
  url: Schema.NullOr(Schema.String),
});
export type CritSidecarStatusResponse = typeof CritSidecarStatusResponse.Type;

/**
 * Ack returned by releaseSidecar: the manager decrements the caller's refCount
 * (tearing the sidecar down at zero). `release_sidecar` never fails, so this is
 * always `{ released: true }`.
 */
export const CritReleaseSidecarResponse = Schema.Struct({
  released: Schema.Boolean,
});
export type CritReleaseSidecarResponse = typeof CritReleaseSidecarResponse.Type;

/**
 * Body of `POST /api/crit/turn`: the caller's own thread plus the message text
 * to start a turn with. The endpoint authorizes via `subject === threadId`, so
 * the threadId is load-bearing for the authorization check.
 */
export const CritTurnRequest = Schema.Struct({
  threadId: ThreadId,
  text: TrimmedNonEmptyString,
});
export type CritTurnRequest = typeof CritTurnRequest.Type;

/**
 * Response of `POST /api/crit/turn`: the thread's latest turn id captured
 * *before* the dispatch, used by the caller as the baseline to detect the newly
 * started turn when polling status. `null` when the thread had no prior turn.
 */
export const CritTurnResponse = Schema.Struct({
  priorTurnId: Schema.NullOr(TurnId),
});
export type CritTurnResponse = typeof CritTurnResponse.Type;

/**
 * Response of `GET /api/crit/turn-status`: the resolved state of the started
 * turn relative to the caller's baseline. `assistantMessageId`/`reply` are only
 * populated once the turn has `completed` with a projected assistant message.
 */
export const CritTurnStatusResponse = Schema.Struct({
  state: Schema.Literals(["pending", "completed", "error", "interrupted"]),
  assistantMessageId: Schema.NullOr(MessageId),
  reply: Schema.NullOr(Schema.String),
});
export type CritTurnStatusResponse = typeof CritTurnStatusResponse.Type;

export class CritError extends Schema.TaggedErrorClass<CritError>()("CritError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

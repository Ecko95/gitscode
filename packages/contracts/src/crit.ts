import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export class CritError extends Schema.TaggedErrorClass<CritError>()("CritError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

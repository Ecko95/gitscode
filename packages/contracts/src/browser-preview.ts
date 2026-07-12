import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BrowserPreviewAction = Schema.Literals([
  "pause",
  "resume",
  "step",
  "abort",
  "takeover",
  "release",
]);
export type BrowserPreviewAction = typeof BrowserPreviewAction.Type;

export const BrowserPreviewLifecycleStatus = Schema.Literals([
  "idle",
  "starting",
  "live",
  "paused",
  "takeover",
  "unavailable",
  "error",
]);
export type BrowserPreviewLifecycleStatus = typeof BrowserPreviewLifecycleStatus.Type;

export const BrowserPreviewThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type BrowserPreviewThreadInput = typeof BrowserPreviewThreadInput.Type;

export const BrowserPreviewControlInput = Schema.Struct({
  threadId: ThreadId,
  action: BrowserPreviewAction,
});
export type BrowserPreviewControlInput = typeof BrowserPreviewControlInput.Type;

export const BrowserPreviewStatus = Schema.Struct({
  available: Schema.Boolean,
  status: BrowserPreviewLifecycleStatus,
  previewPath: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});
export type BrowserPreviewStatus = typeof BrowserPreviewStatus.Type;

export class BrowserPreviewError extends Schema.TaggedErrorClass<BrowserPreviewError>()(
  "BrowserPreviewError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BrowserPreviewAction = Schema.Literals([
  "pause",
  "resume",
  "step",
  "abort",
  "takeover",
  "release",
  "navigate",
  "instruct",
  "connect-localhost",
  "console",
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
  url: Schema.optional(TrimmedNonEmptyString),
  instruction: Schema.optional(TrimmedNonEmptyString),
});
export type BrowserPreviewControlInput = typeof BrowserPreviewControlInput.Type;

export const BrowserPreviewStatus = Schema.Struct({
  available: Schema.Boolean,
  status: BrowserPreviewLifecycleStatus,
  previewPath: Schema.NullOr(TrimmedNonEmptyString),
  terminalUrl: Schema.NullOr(TrimmedNonEmptyString),
  consoleEntries: Schema.Array(Schema.String),
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

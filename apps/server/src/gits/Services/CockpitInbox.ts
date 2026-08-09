import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  CockpitInboxError,
  CockpitInboxItem,
  CockpitInboxListInput,
  CockpitInboxListResult,
  CockpitInboxMarkReadInput,
  CockpitInboxPinInput,
  CockpitInboxState,
} from "@t3tools/contracts";

export interface CockpitInboxRecordInput {
  readonly episodeId: string;
  readonly proposalId: string;
  readonly goalId: string | null;
  readonly title: string;
  readonly repository: string | null;
  readonly eventKey: string;
  readonly state: CockpitInboxState;
  readonly reason: string;
  readonly deepLink: string;
}

export interface CockpitInboxRecordResult {
  readonly item: CockpitInboxItem;
  readonly event: CockpitInboxItem["timeline"][number];
  readonly created: boolean;
}

export interface CockpitInboxShape {
  readonly record: (
    input: CockpitInboxRecordInput,
  ) => Effect.Effect<CockpitInboxRecordResult, CockpitInboxError>;
  readonly list: (
    input: CockpitInboxListInput,
  ) => Effect.Effect<CockpitInboxListResult, CockpitInboxError>;
  readonly markRead: (
    input: CockpitInboxMarkReadInput,
  ) => Effect.Effect<CockpitInboxItem, CockpitInboxError>;
  readonly markAllRead: (
    input: CockpitInboxListInput,
  ) => Effect.Effect<CockpitInboxListResult, CockpitInboxError>;
  readonly setPinned: (
    input: CockpitInboxPinInput,
  ) => Effect.Effect<CockpitInboxItem, CockpitInboxError>;
}

export class CockpitInbox extends Context.Service<CockpitInbox, CockpitInboxShape>()(
  "t3/gits/Services/CockpitInbox",
) {}

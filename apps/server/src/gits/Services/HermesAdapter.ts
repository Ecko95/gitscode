import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  HermesAdapterError,
  HermesChatInput,
  HermesCommandResult,
  HermesDraftFromProposalInput,
  HermesExecutionDraft,
  HermesInspectGitsProposalInput,
  HermesLogTailInput,
  HermesLogTailResult,
  HermesProjectContextInput,
  HermesProjectContextResult,
  HermesProposalCard,
  HermesProposalDecisionInput,
  HermesProposalListResult,
  HermesScheduleRunInput,
  HermesScheduleRunResult,
  HermesSafeConfig,
  HermesSessionListInput,
  HermesSessionListResult,
  HermesStartAcpSessionInput,
  HermesStatusResult,
} from "@t3tools/contracts";

export interface HermesAdapterShape {
  readonly getStatus: () => Effect.Effect<HermesStatusResult, HermesAdapterError>;
  readonly getConfig: () => Effect.Effect<HermesSafeConfig, HermesAdapterError>;
  readonly check: () => Effect.Effect<HermesCommandResult, HermesAdapterError>;
  readonly setupCodexOAuth: () => Effect.Effect<HermesCommandResult, HermesAdapterError>;
  readonly startAcpSession: (
    input: HermesStartAcpSessionInput,
  ) => Effect.Effect<HermesCommandResult, HermesAdapterError>;
  readonly listSessions: (
    input: HermesSessionListInput,
  ) => Effect.Effect<HermesSessionListResult, HermesAdapterError>;
  readonly tailLog: (
    input: HermesLogTailInput,
  ) => Effect.Effect<HermesLogTailResult, HermesAdapterError>;
  readonly listProposals: () => Effect.Effect<HermesProposalListResult, HermesAdapterError>;
  readonly inspectGitsAndPropose: (
    input: HermesInspectGitsProposalInput,
  ) => Effect.Effect<HermesProposalCard, HermesAdapterError>;
  readonly chat: (input: HermesChatInput) => Effect.Effect<HermesProposalCard, HermesAdapterError>;
  readonly decideProposal: (
    input: HermesProposalDecisionInput,
  ) => Effect.Effect<HermesProposalCard, HermesAdapterError>;
  readonly writeProjectContext: (
    input: HermesProjectContextInput,
  ) => Effect.Effect<HermesProjectContextResult, HermesAdapterError>;
  readonly draftFromProposal: (
    input: HermesDraftFromProposalInput,
  ) => Effect.Effect<HermesExecutionDraft, HermesAdapterError>;
  readonly runSchedule: (
    input: HermesScheduleRunInput,
  ) => Effect.Effect<HermesScheduleRunResult, HermesAdapterError>;
}

export class HermesAdapter extends Context.Service<HermesAdapter, HermesAdapterShape>()(
  "t3/gits/Services/HermesAdapter",
) {}

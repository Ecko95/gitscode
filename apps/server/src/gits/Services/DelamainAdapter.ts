import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  DelamainAdapterError,
  DelamainInboxResult,
  DelamainPeer,
  DelamainPeerIntegrateInput,
  DelamainPeerIntegrateResult,
  DelamainPeerKillInput,
  DelamainPeerListResult,
  DelamainPeerLogInput,
  DelamainPeerLogResult,
  DelamainPeerLogParsedResult,
  DelamainPeerReplyInput,
  DelamainReadInboxInput,
  DelamainSendMessageInput,
  DelamainSendMessageResult,
  DelamainSpawnPeerInput,
  DelamainPeerStatusInput,
  DelamainPeerWaitInput,
} from "@t3tools/contracts";

export interface DelamainAdapterShape {
  readonly listPeers: () => Effect.Effect<DelamainPeerListResult, DelamainAdapterError>;
  readonly getPeerStatus: (
    input: DelamainPeerStatusInput,
  ) => Effect.Effect<DelamainPeer, DelamainAdapterError>;
  readonly readPeerLog: (
    input: DelamainPeerLogInput,
  ) => Effect.Effect<DelamainPeerLogResult, DelamainAdapterError>;
  readonly readPeerLogParsed: (
    input: DelamainPeerLogInput,
  ) => Effect.Effect<DelamainPeerLogParsedResult, DelamainAdapterError>;
  readonly spawnPeer: (
    input: DelamainSpawnPeerInput,
  ) => Effect.Effect<DelamainPeer, DelamainAdapterError>;
  readonly killPeer: (
    input: DelamainPeerKillInput,
  ) => Effect.Effect<DelamainPeer, DelamainAdapterError>;
  readonly sendPeerReply: (
    input: DelamainPeerReplyInput,
  ) => Effect.Effect<DelamainPeer, DelamainAdapterError>;
  readonly waitForPeer: (
    input: DelamainPeerWaitInput,
  ) => Effect.Effect<DelamainPeer, DelamainAdapterError>;
  readonly integratePeer: (
    input: DelamainPeerIntegrateInput,
  ) => Effect.Effect<DelamainPeerIntegrateResult, DelamainAdapterError>;
  readonly readInbox: (
    input: DelamainReadInboxInput,
  ) => Effect.Effect<DelamainInboxResult, DelamainAdapterError>;
  readonly sendMessage: (
    input: DelamainSendMessageInput,
  ) => Effect.Effect<DelamainSendMessageResult, DelamainAdapterError>;
}

export class DelamainAdapter extends Context.Service<DelamainAdapter, DelamainAdapterShape>()(
  "t3/gits/Services/DelamainAdapter",
) {}

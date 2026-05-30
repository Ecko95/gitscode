import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  DelamainAdapterError,
  DelamainPeer,
  DelamainPeerIntegrateInput,
  DelamainPeerIntegrateResult,
  DelamainPeerKillInput,
  DelamainPeerListResult,
  DelamainPeerLogInput,
  DelamainPeerLogResult,
  DelamainPeerReplyInput,
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
}

export class DelamainAdapter extends Context.Service<DelamainAdapter, DelamainAdapterShape>()(
  "t3/gits/Services/DelamainAdapter",
) {}

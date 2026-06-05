import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  GitsVerificationGateError,
  GitsVerifyInput,
  GitsVerifyResult,
} from "@t3tools/contracts";

/**
 * GitsVerificationGate — runs an untrusted worktree's verification suite under OS-level
 * confinement (H0). The GITS-side counterpart to the autopilot's confined verification.
 * Commands are server-pinned argv arrays; execution is delegated to `scripts/gits-confine.sh`
 * (verify profile: worktree-only writes, no credentials, network off, npm scripts disabled).
 */
export interface GitsVerificationGateShape {
  readonly run: (
    input: GitsVerifyInput,
  ) => Effect.Effect<GitsVerifyResult, GitsVerificationGateError>;
}

export class GitsVerificationGate extends Context.Service<
  GitsVerificationGate,
  GitsVerificationGateShape
>()("t3/gits/Services/GitsVerificationGate") {}

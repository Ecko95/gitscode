import type * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import type {
  GitsSemanticVerifierError,
  GitsSemanticVerifyInput,
  GitsSemanticVerifyResult,
} from "@t3tools/contracts";

/**
 * GitsSemanticVerifier — the verifier-critic (Rev 2). AFTER the mechanical gate
 * (GitsVerificationGate) is green, a FRESH read-only codex agent judges the diff against the
 * slice's acceptance criteria + an adversarial "what did it miss" pass, and TRIAGES the PR
 * (auto-merge vs hold-for-review). It never blocks the chain. The diff is untrusted data; the
 * verifier runs read-only and is instructed to ignore embedded instructions.
 */
export interface GitsSemanticVerifierShape {
  readonly verify: (
    input: GitsSemanticVerifyInput,
  ) => Effect.Effect<GitsSemanticVerifyResult, GitsSemanticVerifierError>;
}

export class GitsSemanticVerifier extends Context.Service<
  GitsSemanticVerifier,
  GitsSemanticVerifierShape
>()("t3/gits/Services/GitsSemanticVerifier") {}

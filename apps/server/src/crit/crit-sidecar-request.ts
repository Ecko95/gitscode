// Pure assembly of the full `EnsureCritSidecarInput` from the small
// client-facing request + the server-resolved context (origin, wrapper command,
// binary path). The wrapper's bearer token is no longer assembled here — the
// CritSidecarManager mints (and revokes) it itself on the spawn path. Extracted
// from the WS handler so the mapping is unit testable without standing up the
// whole RPC/runtime harness.

import type { EnsureCritSidecarInput } from "./crit-sidecar-manager.ts";

const DEFAULT_CRIT_SIDECAR_HOST = "127.0.0.1";

export interface BuildEnsureSidecarInputArgs {
  readonly request: {
    readonly workspaceRoot: string;
    readonly branch: string;
    readonly threadId: string;
  };
  /** Loopback origin the crit wrapper CLI calls back into the GITS server. */
  readonly origin: string;
  /** The `agent_cmd` crit runs to invoke our wrapper CLI. */
  readonly wrapperCommand: string;
  /** Resolved crit binary path (from resolve_crit_binary_path). */
  readonly binaryPath: string;
}

export function build_ensure_sidecar_input(
  args: BuildEnsureSidecarInputArgs,
): EnsureCritSidecarInput {
  return {
    workspaceRoot: args.request.workspaceRoot,
    branch: args.request.branch,
    threadId: args.request.threadId,
    origin: args.origin,
    wrapperCommand: args.wrapperCommand,
    binaryPath: args.binaryPath,
    host: DEFAULT_CRIT_SIDECAR_HOST,
  };
}

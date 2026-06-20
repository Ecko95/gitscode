export interface AutomodeGitArgv {
  readonly operation: string;
  readonly args: ReadonlyArray<string>;
}

export interface EnsureIntegrationBranchInput {
  readonly integrationBranch: string;
  readonly baseRef: string; // e.g. "gits"
}

// Idempotent create-from-base. The runner only invokes this when the integration
// branch does not yet exist on origin (ls-remote check), so the push is a creation.
export function build_ensure_integration_branch_commands(
  input: EnsureIntegrationBranchInput,
): ReadonlyArray<AutomodeGitArgv> {
  return [
    { operation: "automode-fetch-base", args: ["fetch", "origin", input.baseRef] },
    {
      operation: "automode-create-integration",
      args: [
        "push",
        "origin",
        `refs/remotes/origin/${input.baseRef}:refs/heads/${input.integrationBranch}`,
      ],
    },
  ];
}

export interface LandSliceInput {
  readonly sliceBranch: string;
  readonly integrationBranch: string;
}

// Fast-forward the integration branch to the verified slice tip. Because the peer
// branched FROM the integration tip (dispatch sets startRef) and v1 is sequential,
// this push is a fast-forward; a non-FF rejection means the chain diverged and the
// runner halts.
export function build_land_slice_commands(input: LandSliceInput): ReadonlyArray<AutomodeGitArgv> {
  return [
    { operation: "automode-fetch-slice", args: ["fetch", "origin", input.sliceBranch] },
    {
      operation: "automode-land-slice",
      args: [
        "push",
        "origin",
        `refs/remotes/origin/${input.sliceBranch}:refs/heads/${input.integrationBranch}`,
      ],
    },
  ];
}

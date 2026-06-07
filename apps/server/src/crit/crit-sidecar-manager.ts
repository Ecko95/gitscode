// Pure spawn-spec builder for the crit sidecar.
// NOTE: The Effect service lives below this helper (Task 4b adds it to this same file).

export interface CritSpawnInput {
  readonly binaryPath: string;
  readonly repoRoot: string;
  readonly branch: string;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly threadId: string;
  readonly wrapperCommand: string;
}

export interface CritSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly url: string;
}

export function build_crit_spawn_spec(input: CritSpawnInput): CritSpawnSpec {
  // NOTE: flag names below are PLACEHOLDERS pending Task 0b (crit's real CLI flags —
  // see docs/crit-integration-notes.md "## CLI"). Correct them once crit can be built.
  return {
    command: input.binaryPath,
    args: [
      "--repo",
      input.repoRoot,
      "--branch",
      input.branch,
      "--host",
      input.host,
      "--port",
      String(input.port),
      "--agent-cmd",
      input.wrapperCommand,
    ],
    env: {
      GITS_ORIGIN: input.origin,
      GITS_TOKEN: input.token,
      GITS_THREAD_ID: input.threadId,
    },
    url: `http://${input.host}:${input.port}`,
  };
}

import { applyDirenvDelta, resolveDirenvEnvironment } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

/**
 * Resolves this session's `.envrc` delta (if any) via `resolveDirenvEnvironment`
 * and layers it under `baseEnv` via `applyDirenvDelta`. Shared by the four
 * provider adapters (Claude/Codex/Cursor/OpenCode) — identical logic at each
 * call site modulo which env resolves the `direnv` binary itself (`execEnv`,
 * defaults to `baseEnv`).
 *
 * `resolveDirenvEnvironment` is async (#134) so a slow/hung direnv invocation
 * never blocks the event loop; `Effect.promise` is correct here because it
 * never rejects (failure-safe by design — see shell.ts).
 */
export function resolveSessionEnvWithDirenv(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv,
  execEnv: NodeJS.ProcessEnv = baseEnv,
): Effect.Effect<NodeJS.ProcessEnv> {
  return Effect.promise(() => resolveDirenvEnvironment(cwd, execEnv)).pipe(
    Effect.map((delta) => applyDirenvDelta(baseEnv, delta)),
  );
}

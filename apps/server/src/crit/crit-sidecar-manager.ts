// Pure spawn-spec builder for the crit sidecar.
// NOTE: The Effect service lives below this helper (Task 4b adds it to this same file).

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@t3tools/shared/Net";

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

// ---------------------------------------------------------------------------
// Task 4b: CritSidecarManager Effect service
// ---------------------------------------------------------------------------

export class CritSidecarError extends Data.TaggedError("CritSidecarError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export type CritSidecarStatus = "starting" | "ready" | "crashed" | "stopped";

export interface CritSidecarHandle {
  readonly status: CritSidecarStatus;
  readonly url: string | null;
}

export interface EnsureCritSidecarInput {
  readonly workspaceRoot: string;
  readonly branch: string;
  readonly threadId: string;
  readonly origin: string; // GITS server origin the wrapper will call
  readonly token: string; // scoped bearer token for the wrapper
  readonly wrapperCommand: string; // the agent_cmd crit runs (e.g. "node /path/crit-agent-cli.js")
  readonly binaryPath: string; // resolved crit binary (caller uses resolve_crit_binary_path)
  readonly host?: string; // default "127.0.0.1"
  readonly readinessTimeoutMs?: number; // default 10_000
}

export interface CritSidecarManagerShape {
  readonly ensure_sidecar: (
    input: EnsureCritSidecarInput,
  ) => Effect.Effect<CritSidecarHandle, CritSidecarError>;
  /** Never fails; returns { status:"stopped", url:null } when the workspace is unknown. */
  readonly sidecar_status: (workspaceRoot: string) => Effect.Effect<CritSidecarHandle>;
  readonly release_sidecar: (workspaceRoot: string) => Effect.Effect<void>;
}

interface CritSidecarEntry {
  readonly url: string;
  readonly port: number;
  status: CritSidecarStatus;
  refCount: number;
  readonly scope: Scope.Scope.Closeable;
}

const DEFAULT_CRIT_HOST = "127.0.0.1";
const DEFAULT_CRIT_BASE_PORT = 4400;
const DEFAULT_CRIT_READINESS_TIMEOUT_MS = 10_000;
// Interval between readiness probe attempts while the sidecar boots.
const CRIT_READINESS_PROBE_INTERVAL_MS = 100;

const makeCritSidecarManager = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const httpClient = yield* HttpClient.HttpClient;

  const entries = yield* Ref.make(new Map<string, CritSidecarEntry>());

  const sidecar_status: CritSidecarManagerShape["sidecar_status"] = (workspaceRoot) =>
    Ref.get(entries).pipe(
      Effect.map((map) => {
        const entry = map.get(workspaceRoot);
        return entry
          ? ({ status: entry.status, url: entry.url } satisfies CritSidecarHandle)
          : ({ status: "stopped", url: null } satisfies CritSidecarHandle);
      }),
    );

  const release_sidecar: CritSidecarManagerShape["release_sidecar"] = (workspaceRoot) =>
    Effect.gen(function* () {
      const map = yield* Ref.get(entries);
      const entry = map.get(workspaceRoot);
      if (!entry) {
        return;
      }
      entry.refCount -= 1;
      if (entry.refCount > 0) {
        return;
      }
      // v1: immediate teardown once the last consumer releases. A future
      // refinement could keep the sidecar warm behind an idle timeout instead.
      entry.status = "stopped";
      yield* Scope.close(entry.scope, Exit.void);
      yield* Ref.update(entries, (current) => {
        const next = new Map(current);
        next.delete(workspaceRoot);
        return next;
      });
    });

  // Probes the sidecar root URL. ANY HTTP response (regardless of status code)
  // means crit is listening; a transport-level failure means it is not up yet.
  const probeReadiness = (url: string) =>
    httpClient.execute(HttpClientRequest.get(url)).pipe(Effect.asVoid);

  const ensure_sidecar: CritSidecarManagerShape["ensure_sidecar"] = (input) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(entries)).get(input.workspaceRoot);
      if (existing && existing.status === "ready") {
        existing.refCount += 1;
        return { status: "ready", url: existing.url } satisfies CritSidecarHandle;
      }

      const host = input.host ?? DEFAULT_CRIT_HOST;
      const readinessTimeoutMs = input.readinessTimeoutMs ?? DEFAULT_CRIT_READINESS_TIMEOUT_MS;

      const port = yield* netService.findAvailablePort(DEFAULT_CRIT_BASE_PORT).pipe(
        Effect.mapError(
          (cause) =>
            new CritSidecarError({
              operation: "ensure_sidecar",
              detail: `Failed to find an available port for the crit sidecar: ${String(cause)}`,
              cause,
            }),
        ),
      );

      const spec = build_crit_spawn_spec({
        binaryPath: input.binaryPath,
        repoRoot: input.workspaceRoot,
        branch: input.branch,
        host,
        port,
        origin: input.origin,
        token: input.token,
        threadId: input.threadId,
        wrapperCommand: input.wrapperCommand,
      });

      // Per-sidecar scope: closing it runs the kill finalizer registered below.
      const scope = yield* Scope.make();

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spec.command, [...spec.args], {
            shell: process.platform === "win32",
            env: { ...process.env, ...spec.env },
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new CritSidecarError({
                operation: "ensure_sidecar",
                detail: `Failed to spawn the crit sidecar process: ${String(cause)}`,
                cause,
              }),
          ),
        );

      const terminateChild = child
        .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
        .pipe(Effect.ignore);
      yield* Scope.addFinalizer(scope, terminateChild);

      const entry: CritSidecarEntry = {
        url: spec.url,
        port,
        status: "starting",
        refCount: 1,
        scope,
      };
      yield* Ref.update(entries, (current) => {
        const next = new Map(current);
        next.set(input.workspaceRoot, entry);
        return next;
      });

      // Poll the sidecar until it answers an HTTP request, capped by the timeout.
      const readinessProbe = Effect.retry(probeReadiness(spec.url), {
        schedule: Schedule.spaced(CRIT_READINESS_PROBE_INTERVAL_MS),
      });

      // If the process exits before it becomes ready, surface a crash instead of
      // waiting for the full timeout (mirrors opencodeRuntime's exit-fiber race).
      const exitWatcher = child.exitCode.pipe(
        Effect.flatMap(
          (code) =>
            new CritSidecarError({
              operation: "ensure_sidecar",
              detail: `The crit sidecar exited before becoming ready (code: ${String(code)}).`,
            }),
        ),
      );

      // On success the sidecar is listening. On failure either the process
      // crashed (our `CritSidecarError`) or the timeout elapsed (a
      // `Cause.TimeoutError` injected by `Effect.timeout`).
      const readyExit = yield* Effect.exit(
        Effect.race(readinessProbe, exitWatcher).pipe(Effect.timeout(readinessTimeoutMs)),
      );

      if (Exit.isSuccess(readyExit)) {
        entry.status = "ready";
        return { status: "ready", url: spec.url } satisfies CritSidecarHandle;
      }

      // Timed out or the process crashed: tear down and remove the entry so a
      // later ensure_sidecar can retry from scratch.
      entry.status = "crashed";
      yield* Scope.close(scope, Exit.void);
      yield* Ref.update(entries, (current) => {
        const next = new Map(current);
        next.delete(input.workspaceRoot);
        return next;
      });

      const failure = Cause.failureOption(readyExit.cause);
      if (Option.isSome(failure) && failure.value instanceof CritSidecarError) {
        return yield* failure.value;
      }

      return yield* new CritSidecarError({
        operation: "ensure_sidecar",
        detail: `Timed out waiting for the crit sidecar to become ready after ${readinessTimeoutMs}ms.`,
        cause: readyExit.cause,
      });
    });

  return {
    ensure_sidecar,
    sidecar_status,
    release_sidecar,
  } satisfies CritSidecarManagerShape;
});

export class CritSidecarManager extends Context.Service<
  CritSidecarManager,
  CritSidecarManagerShape
>()("t3/crit/CritSidecarManager") {}

export const layer = Layer.effect(CritSidecarManager, makeCritSidecarManager).pipe(
  Layer.provide(NetService.layer),
);

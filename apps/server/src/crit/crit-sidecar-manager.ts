// Pure spawn-spec builder for the crit sidecar.
// NOTE: The Effect service lives below this helper (Task 4b adds it to this same file).

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@t3tools/shared/Net";

import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";

export interface CritSpawnInput {
  readonly binaryPath: string;
  readonly repoRoot: string;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly threadId: string;
  // Isolated HOME for this sidecar. crit resolves its global config via
  // os.UserHomeDir() ($HOME), and `agent_cmd` is honored only from the global
  // config — so we point crit at a private HOME holding a `.crit.config.json`
  // with our wrapper, instead of mutating the user's real ~/.crit.config.json.
  readonly critHome: string;
}

export interface CritSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  // crit reviews the repository at its working directory (there is no --repo
  // flag); the manager spawns it with cwd set to the workspace root.
  readonly cwd: string;
  readonly url: string;
}

export function build_crit_spawn_spec(input: CritSpawnInput): CritSpawnSpec {
  // crit v0.16 CLI: bind host/port, never open a browser (headless sidecar),
  // and suppress status chatter. The repo is selected via cwd, and `agent_cmd`
  // via the isolated-HOME `.crit.config.json` (written by the manager) — not flags.
  return {
    command: input.binaryPath,
    args: ["--host", input.host, "--port", String(input.port), "--no-open", "--quiet"],
    env: {
      HOME: input.critHome,
      // Consumed by the agent_cmd wrapper crit spawns for "send to agent".
      GITS_ORIGIN: input.origin,
      GITS_TOKEN: input.token,
      GITS_THREAD_ID: input.threadId,
    },
    cwd: input.repoRoot,
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
  // Mutable so a "starting" reservation can be inserted synchronously (before any
  // suspending operation) and then filled in once port allocation + spawn complete.
  url: string | null;
  port: number | null;
  status: CritSidecarStatus;
  refCount: number;
  scope: Scope.Closeable | null;
  // ponytail: one readiness gate is enough to propagate cold-start success/failure to reusers.
  readiness: Deferred.Deferred<CritSidecarHandle, CritSidecarError>;
}

const DEFAULT_CRIT_HOST = "127.0.0.1";
const DEFAULT_CRIT_BASE_PORT = 4400;
const DEFAULT_CRIT_READINESS_TIMEOUT_MS = 10_000;
// Interval between readiness probe attempts while the sidecar boots.
const CRIT_READINESS_PROBE_INTERVAL_MS = 100;
// Bounded lifetime for the thread-scoped session minted for a sidecar. The token
// is also revoked on every teardown path (see the scope finalizer below); the
// TTL is a backstop in case the process/server dies without running finalizers.
const CRIT_SIDECAR_SESSION_TTL = Duration.hours(2);

const makeCritSidecarManager = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const httpClient = yield* HttpClient.HttpClient;
  const authControlPlane = yield* AuthControlPlane;
  const fileSystem = yield* FileSystem.FileSystem;

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
      if (entry.scope !== null) {
        yield* Scope.close(entry.scope, Exit.void);
      }
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
      // Close the double-spawn race SYNCHRONOUSLY: read the map and, in the same
      // tick (no `yield*` between get and set), either reuse a live/starting entry
      // or insert a "starting" reservation. Effect fibers are cooperative, so a
      // re-entrant ensure_sidecar for the same workspaceRoot cannot interleave
      // between the get and the reservation insert below.
      const readiness = yield* Deferred.make<CritSidecarHandle, CritSidecarError>();
      const map = yield* Ref.get(entries);
      const existing = map.get(input.workspaceRoot);
      if (existing?.status === "ready") {
        existing.refCount += 1;
        return { status: existing.status, url: existing.url } satisfies CritSidecarHandle;
      }
      if (existing?.status === "starting") {
        existing.refCount += 1;
        return yield* Deferred.await(existing.readiness).pipe(
          Effect.onInterrupt(() =>
            Ref.update(entries, (current) => {
              if (current.get(input.workspaceRoot) === existing && existing.status === "starting") {
                existing.refCount -= 1;
              }
              return current;
            }),
          ),
        );
      }

      // No usable entry — insert the "starting" reservation immediately so a
      // concurrent/re-entrant call sees it and reuses it instead of spawning.
      const entry: CritSidecarEntry = {
        url: null,
        port: null,
        status: "starting",
        refCount: 1,
        scope: null,
        readiness,
      };
      const reserved = new Map(map);
      if (existing) {
        // Stale "crashed"/"stopped" entry — drop it before reserving anew.
        reserved.delete(input.workspaceRoot);
      }
      reserved.set(input.workspaceRoot, entry);
      yield* Ref.set(entries, reserved);

      // Drop the reservation (and close its scope, if one was opened) when start-up
      // bails out before the entry is healthy, so a later ensure_sidecar can retry.
      const removeReservation = Ref.update(entries, (current) => {
        if (current.get(input.workspaceRoot) !== entry) {
          return current;
        }
        const next = new Map(current);
        next.delete(input.workspaceRoot);
        return next;
      });

      const host = input.host ?? DEFAULT_CRIT_HOST;
      const readinessTimeoutMs = input.readinessTimeoutMs ?? DEFAULT_CRIT_READINESS_TIMEOUT_MS;

      // Per-sidecar scope: closing it runs the kill + session-revoke finalizers
      // registered below. Created up-front so the SPAWN path owns a single scope
      // whose closure (on EVERY teardown path: release-at-0, readiness timeout,
      // crash, spawn failure) revokes the minted session token.
      const scope = yield* Scope.make();

      // Tear down the scope and drop the reservation when start-up bails out before
      // the entry is healthy, so a later ensure_sidecar can retry from scratch.
      // Closing the scope also runs the session-revoke finalizer registered below.
      const abortStartup = (error: CritSidecarError) =>
        Effect.gen(function* () {
          yield* Deferred.fail(entry.readiness, error).pipe(Effect.ignore);
          yield* Scope.close(scope, Exit.void);
          yield* removeReservation;
        });

      // Mint the wrapper's bearer token ONLY on the spawn path (reuse increments
      // refCount above and never reaches here), with a bounded TTL. The session is
      // revoked when `scope` closes — wiring it here means every teardown path
      // that closes the scope also revokes the token.
      // NOTE: the token is role:"thread-scoped" bound to subject:threadId — a
      // dedicated least-privilege capability minted ONLY for the crit sidecar. It
      // can reach ONLY the /api/crit/{turn,turn-status} endpoints for its own
      // thread, which require session.subject === threadId; a token for thread A is
      // rejected (403) for thread B. The thread-scoped role is explicitly DENIED at
      // the broad surfaces it must not touch: POST /api/auth/ws-token and the GET
      // /ws upgrade (centralized deny in ServerAuth — see apps/server/src/auth/
      // Services/ServerAuth.ts + Layers/ServerAuth.ts, asserted in ServerAuth.test.ts
      // and critHttp.test.ts) and GET /api/attachments/*. It also cannot reach the
      // owner-gated /api/orchestration/* endpoints (role !== "owner"). So even a
      // *leaked* sidecar token confers no broader reach than starting a turn on its
      // own thread. The bounded TTL + revoke-on-teardown wired here further cap the
      // blast radius. This guarantee HOLDS — it is no longer a residual gap.
      const issued = yield* authControlPlane
        .issueSession({
          role: "thread-scoped",
          subject: input.threadId,
          label: `crit sidecar ${input.workspaceRoot}`,
          ttl: CRIT_SIDECAR_SESSION_TTL,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CritSidecarError({
                operation: "ensure_sidecar",
                detail: `Failed to mint a crit sidecar session token: ${String(cause)}`,
                cause,
              }),
          ),
          Effect.tapError((error) => abortStartup(error)),
        );
      yield* Scope.addFinalizer(
        scope,
        authControlPlane.revokeSession(issued.sessionId).pipe(Effect.ignore),
      );

      const port = yield* netService.findAvailablePort(DEFAULT_CRIT_BASE_PORT).pipe(
        Effect.mapError(
          (cause) =>
            new CritSidecarError({
              operation: "ensure_sidecar",
              detail: `Failed to find an available port for the crit sidecar: ${String(cause)}`,
              cause,
            }),
        ),
        Effect.tapError((error) => abortStartup(error)),
      );

      // Private HOME so crit reads OUR global config (with the wrapper as
      // agent_cmd) instead of the user's real ~/.crit.config.json. Removed on
      // teardown via the scope finalizer.
      const critHome = yield* fileSystem.makeTempDirectory({ prefix: "gits-crit-" }).pipe(
        Effect.mapError(
          (cause) =>
            new CritSidecarError({
              operation: "ensure_sidecar",
              detail: `Failed to create the crit sidecar home directory: ${String(cause)}`,
              cause,
            }),
        ),
        Effect.tapError((error) => abortStartup(error)),
      );
      yield* Scope.addFinalizer(
        scope,
        fileSystem.remove(critHome, { recursive: true }).pipe(Effect.ignore),
      );
      // crit owns this config's schema; a Schema round-trip buys nothing here.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const critConfigJson = JSON.stringify({ agent_cmd: input.wrapperCommand }, null, 2);
      yield* fileSystem.writeFileString(`${critHome}/.crit.config.json`, critConfigJson).pipe(
        Effect.mapError(
          (cause) =>
            new CritSidecarError({
              operation: "ensure_sidecar",
              detail: `Failed to write the crit sidecar config: ${String(cause)}`,
              cause,
            }),
        ),
        Effect.tapError((error) => abortStartup(error)),
      );

      const spec = build_crit_spawn_spec({
        binaryPath: input.binaryPath,
        repoRoot: input.workspaceRoot,
        host,
        port,
        origin: input.origin,
        token: issued.token,
        threadId: input.threadId,
        critHome,
      });

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spec.command, [...spec.args], {
            shell: process.platform === "win32",
            env: { ...process.env, ...spec.env },
            cwd: spec.cwd,
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
          Effect.tapError((error) => abortStartup(error)),
        );

      const terminateChild = child
        .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
        .pipe(Effect.ignore);
      yield* Scope.addFinalizer(scope, terminateChild);

      // Fill the "starting" reservation in place — preserve refCount/identity so a
      // concurrent reuser's increment is not lost.
      entry.url = spec.url;
      entry.port = port;
      entry.scope = scope;

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
        // Transition the existing reservation in place — keep its refCount/scope.
        entry.status = "ready";
        const handle = { status: "ready", url: spec.url } satisfies CritSidecarHandle;
        yield* Deferred.succeed(entry.readiness, handle).pipe(Effect.ignore);
        return handle;
      }

      // Mirror opencodeRuntime's readiness-failure idiom: squash the cause to a
      // single value. If it already IS a CritSidecarError (the crash watcher's
      // failure), surface it as-is; otherwise wrap it (e.g. the timeout case,
      // where `Effect.timeout` injects a `Cause.TimeoutError`).
      const squashed = Cause.squash(readyExit.cause);
      const error =
        squashed instanceof CritSidecarError
          ? squashed
          : new CritSidecarError({
              operation: "ensure_sidecar",
              detail: `Timed out waiting for the crit sidecar to become ready after ${readinessTimeoutMs}ms: ${String(squashed)}`,
              cause: squashed,
            });
      yield* Deferred.fail(entry.readiness, error).pipe(Effect.ignore);

      // Timed out or the process crashed: tear down and remove the entry so a
      // later ensure_sidecar can retry from scratch.
      entry.status = "crashed";
      yield* Scope.close(scope, Exit.void);
      yield* removeReservation;
      return yield* error;
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
>()("t3/crit/crit-sidecar-manager/CritSidecarManager") {}

export const layer = Layer.effect(CritSidecarManager, makeCritSidecarManager).pipe(
  Layer.provide(NetService.layer),
);

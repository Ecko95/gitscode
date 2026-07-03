import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

/**
 * One poller fiber per repository (repoKey = gitCommonDir).
 * All worktrees of the same repo share this poller — the automatic refresh runs
 * once per interval for the whole repo, not once per worktree.
 */
interface ActiveRepoPoller {
  readonly fiber: Fiber.Fiber<void, never>;
  /** Per-cwd subscriber refcount within this repo group. */
  readonly cwdSubscriberCounts: Map<string, number>;
  /** The interval effect shared by all subscribers for this repo. */
  readonly automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export interface VcsStatusBroadcasterShape {
  readonly getStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly refreshLocalStatus: (
    cwd: string,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly streamStatus: (
    input: VcsStatusInput,
    options?: StreamStatusOptions,
  ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  VcsStatusBroadcasterShape
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

export const layer = Layer.effect(
  VcsStatusBroadcaster,
  Effect.gen(function* () {
    const workflow = yield* GitWorkflowService.GitWorkflowService;
    const fs = yield* FileSystem.FileSystem;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<VcsStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());

    // ponytail: one poller per repoKey (gitCommonDir) instead of per cwd — O(repos) not O(worktrees).
    // The poller fiber runs refreshRemoteStatus for all registered cwds in a single loop body,
    // so the repository-scoped git fetch (gated by GitVcsDriverCore.statusRemoteRefreshCache)
    // runs once per repo per interval rather than once per worktree.
    const repoPollerRef = yield* SynchronizedRef.make(new Map<string, ActiveRepoPoller>());

    // Coalescing worker for EXPLICIT refresh signals (e.g., concurrent refreshStatus calls for
    // multiple worktrees of the same repo). Key = repoKey. The automatic polling uses the per-repo
    // fiber directly; the worker coalesces concurrent manual triggers.
    // ponytail: value = null (trigger-only); merge = const null; cwds looked up at process time.
    const explicitRefreshWorker = yield* makeKeyedCoalescingWorker<string, null, never, never>({
      merge: (_current, _next) => null,
      process: (repoKey, _) =>
        Effect.gen(function* () {
          const pollers = yield* SynchronizedRef.get(repoPollerRef);
          const poller = pollers.get(repoKey);
          if (!poller) return;
          const cwds = Array.from(poller.cwdSubscriberCounts.keys());
          yield* Effect.all(
            cwds.map((cwd) => refreshRemoteStatus(cwd).pipe(Effect.ignore)),
            { concurrency: "unbounded", discard: true },
          );
        }),
    }).pipe(Effect.provideService(Scope.Scope, broadcasterScope));

    const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

    const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
      cwd: string,
    ) {
      return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
    });

    const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
      function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
        const nextLocal = {
          fingerprint: fingerprintStatusPart(local),
          value: local,
        } satisfies CachedValue<VcsStatusLocalResult>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            local: nextLocal,
          });
          return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "localUpdated",
              local,
            },
          });
        }

        return local;
      },
    );

    const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
      function* (
        cwd: string,
        remote: VcsStatusRemoteResult | null,
        options?: { publish?: boolean },
      ) {
        const nextRemote = {
          fingerprint: fingerprintStatusPart(remote),
          value: remote,
        } satisfies CachedValue<VcsStatusRemoteResult | null>;
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(cwd) ?? { local: null, remote: null };
          const nextCache = new Map(cache);
          nextCache.set(cwd, {
            ...previous,
            remote: nextRemote,
          });
          return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
        });

        if (options?.publish && shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd,
            event: {
              _tag: "remoteUpdated",
              remote,
            },
          });
        }

        return remote;
      },
    );

    const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
      cwd: string,
    ) {
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local);
    });

    const loadRemoteStatus = Effect.fn("VcsStatusBroadcaster.loadRemoteStatus")(function* (
      cwd: string,
    ) {
      const remote = yield* workflow.remoteStatus({ cwd });
      return yield* updateCachedRemoteStatus(cwd, remote);
    });

    const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
      cwd: string,
    ) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        return cached.local.value;
      }
      return yield* loadLocalStatus(cwd);
    });

    const getOrLoadRemoteStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadRemoteStatus")(
      function* (cwd: string) {
        const cached = yield* getCachedStatus(cwd);
        if (cached?.remote) {
          return cached.remote.value;
        }
        return yield* loadRemoteStatus(cwd);
      },
    );

    const getStatus: VcsStatusBroadcasterShape["getStatus"] = Effect.fn(
      "VcsStatusBroadcaster.getStatus",
    )(function* (input) {
      const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
      const [local, remote] = yield* Effect.all([
        getOrLoadLocalStatus(cwd),
        getOrLoadRemoteStatus(cwd),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    const refreshLocalStatus: VcsStatusBroadcasterShape["refreshLocalStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshLocalStatus",
    )(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, { publish: true });
    });

    const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
      cwd: string,
    ) {
      yield* workflow.invalidateRemoteStatus(cwd);
      const remote = yield* workflow.remoteStatus({ cwd });
      return yield* updateCachedRemoteStatus(cwd, remote, { publish: true });
    });

    const refreshStatus: VcsStatusBroadcasterShape["refreshStatus"] = Effect.fn(
      "VcsStatusBroadcaster.refreshStatus",
    )(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      const [local, remote] = yield* Effect.all([
        refreshLocalStatus(cwd),
        refreshRemoteStatus(cwd),
      ]);
      return mergeGitStatusParts(local, remote);
    });

    /** Resolve the coalescing key: gitCommonDir, or fall back to cwd for non-git repos. */
    const resolveRepoKey = (cwd: string): Effect.Effect<string> =>
      workflow.resolveRepoKey(cwd).pipe(Effect.map((key) => key ?? cwd));

    /**
     * Per-repo polling loop. Runs refreshRemoteStatus for ALL registered cwds in a single
     * fiber body. Because this fiber runs the refresh work directly (not in a sub-fiber),
     * interrupting this fiber (via releaseRepoPoller) also interrupts any in-flight
     * refreshRemoteStatus call — preserving correct cleanup semantics.
     */
    const makeRemoteRefreshLoop = (
      repoKey: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ) => {
      return Effect.gen(function* () {
        const consecutiveFailuresRef = yield* Ref.make(0);
        const refreshIfEnabled = Effect.gen(function* () {
          const configuredInterval = yield* automaticRemoteRefreshInterval;
          const activeInterval = Duration.isZero(configuredInterval)
            ? DEFAULT_VCS_STATUS_REFRESH_INTERVAL
            : configuredInterval;
          if (Duration.isZero(configuredInterval)) {
            return activeInterval;
          }

          // Refresh ALL cwds registered for this repo in one batch.
          // The per-cwd calls share the same git fetch via GitVcsDriverCore.statusRemoteRefreshCache
          // (keyed by gitCommonDir+remoteName, 15s TTL) — so the network fetch runs once.
          const pollers = yield* SynchronizedRef.get(repoPollerRef);
          const cwds = Array.from(pollers.get(repoKey)?.cwdSubscriberCounts.keys() ?? []);
          const exit = yield* Effect.all(
            cwds.map((cwd) => refreshRemoteStatus(cwd).pipe(Effect.ignore)),
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.exit);

          if (Exit.isSuccess(exit)) {
            yield* Ref.set(consecutiveFailuresRef, 0);
            return activeInterval;
          }

          const consecutiveFailures = yield* Ref.updateAndGet(
            consecutiveFailuresRef,
            (count) => count + 1,
          );
          const nextDelay = remoteRefreshFailureDelay(consecutiveFailures, activeInterval);
          yield* Effect.logWarning("VCS remote status refresh failed", {
            repoKey,
            detail: exit.cause.toString(),
            consecutiveFailures,
            nextDelayMs: Duration.toMillis(nextDelay),
          });
          return nextDelay;
        });

        return yield* refreshIfEnabled.pipe(
          Effect.repeat(
            Schedule.identity<Duration.Duration>().pipe(
              Schedule.addDelay((delay) => Effect.succeed(delay)),
            ),
          ),
          Effect.asVoid,
        );
      });
    };

    const retainRepoPoller = Effect.fn("VcsStatusBroadcaster.retainRepoPoller")(function* (
      repoKey: string,
      cwd: string,
      automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    ) {
      yield* SynchronizedRef.modifyEffect(repoPollerRef, (activePollers) => {
        const existing = activePollers.get(repoKey);
        if (existing) {
          const nextCwdCounts = new Map(existing.cwdSubscriberCounts);
          nextCwdCounts.set(cwd, (nextCwdCounts.get(cwd) ?? 0) + 1);
          const nextPollers = new Map(activePollers);
          nextPollers.set(repoKey, { ...existing, cwdSubscriberCounts: nextCwdCounts });
          return Effect.succeed([undefined, nextPollers] as const);
        }

        return makeRemoteRefreshLoop(repoKey, automaticRemoteRefreshInterval).pipe(
          Effect.forkIn(broadcasterScope),
          Effect.map((fiber) => {
            const nextPollers = new Map(activePollers);
            nextPollers.set(repoKey, {
              fiber,
              cwdSubscriberCounts: new Map([[cwd, 1]]),
              automaticRemoteRefreshInterval,
            });
            return [undefined, nextPollers] as const;
          }),
        );
      });
    });

    const releaseRepoPoller = Effect.fn("VcsStatusBroadcaster.releaseRepoPoller")(function* (
      repoKey: string,
      cwd: string,
    ) {
      const pollerToInterrupt = yield* SynchronizedRef.modify(repoPollerRef, (activePollers) => {
        const existing = activePollers.get(repoKey);
        if (!existing) {
          return [null, activePollers] as const;
        }

        const nextCwdCounts = new Map(existing.cwdSubscriberCounts);
        const currentCount = nextCwdCounts.get(cwd) ?? 1;
        if (currentCount > 1) {
          nextCwdCounts.set(cwd, currentCount - 1);
        } else {
          nextCwdCounts.delete(cwd);
        }

        if (nextCwdCounts.size > 0) {
          // Other cwds of this repo still subscribed: keep the poller, update count
          const nextPollers = new Map(activePollers);
          nextPollers.set(repoKey, { ...existing, cwdSubscriberCounts: nextCwdCounts });
          return [null, nextPollers] as const;
        }

        // Last subscriber for this repo: stop the poller
        const nextPollers = new Map(activePollers);
        nextPollers.delete(repoKey);
        return [existing.fiber, nextPollers] as const;
      });

      if (pollerToInterrupt) {
        yield* Fiber.interrupt(pollerToInterrupt).pipe(Effect.ignore);
      }
    });

    const streamStatus: VcsStatusBroadcasterShape["streamStatus"] = (input, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
          const repoKey = yield* resolveRepoKey(cwd);
          const subscription = yield* PubSub.subscribe(changesPubSub);
          const initialLocal = yield* getOrLoadLocalStatus(cwd);
          const initialRemote = (yield* getCachedStatus(cwd))?.remote?.value ?? null;
          yield* retainRepoPoller(
            repoKey,
            cwd,
            options?.automaticRemoteRefreshInterval ??
              Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
          );

          const release = releaseRepoPoller(repoKey, cwd).pipe(Effect.ignore, Effect.asVoid);

          return Stream.concat(
            Stream.make({
              _tag: "snapshot" as const,
              local: initialLocal,
              remote: initialRemote,
            }),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((event) => event.cwd === cwd),
              Stream.map((event) => event.event),
            ),
          ).pipe(Stream.ensuring(release));
        }),
      );

    return VcsStatusBroadcaster.of({
      getStatus,
      refreshLocalStatus,
      refreshStatus,
      streamStatus,
    });
  }),
);

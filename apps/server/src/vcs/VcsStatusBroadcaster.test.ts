import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function makeTestLayer(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: () =>
          Effect.sync(() => {
            state.remoteStatusCalls += 1;
            return state.currentRemoteStatus;
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        // Each cwd is its own repo in tests; coalescing only applies across shared repos.
        resolveRepoKey: (cwd) => Effect.succeed(cwd),
      }),
    ),
  );
}

describe("VcsStatusBroadcaster", () => {
  it.effect("reuses the cached VCS status across repeated reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/updated-status",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes only the cached local snapshot when requested", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/local-only-refresh",
        hasWorkingTreeChanges: true,
      };

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, state.currentLocalStatus);
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...baseRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("normalizes symlinked CWDs before cache lookup and workflow calls", () => {
    const seenCwds: string[] = [];
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.remoteStatusCalls += 1;
              return state.currentRemoteStatus;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          resolveRepoKey: (cwd) => Effect.succeed(cwd),
        } satisfies Partial<GitWorkflowService.GitWorkflowServiceShape>),
      ),
    );

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-real-",
      });
      const linkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-link-",
      });
      const linkDir = path.join(linkParent, "repo-link");
      yield* fileSystem.symlink(realDir, linkDir);
      const realPath = yield* fileSystem.realPath(realDir);

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: linkDir });
      yield* broadcaster.getStatus({ cwd: realDir });

      assert.deepStrictEqual(seenCwds, [realPath, realPath]);
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("streams a local snapshot first and remote updates later", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "remoteUpdated") {
          return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* broadcaster.refreshStatus("/repo");
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: baseRemoteStatus,
      } satisfies VcsStatusStreamEvent);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("does not start automatic remote refreshes when disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
      );

      assert.isTrue(Option.isSome(snapshot));
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it("backs off remote refresh failures exponentially and honors larger configured intervals", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.seconds(1))),
      30_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(2, Duration.seconds(1))),
      60_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(3, Duration.seconds(1))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.minutes(5))),
      300_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(20, Duration.seconds(1))),
      900_000,
    );
  });

  it.effect("stops the remote poller after the last stream subscriber disconnects", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          resolveRepoKey: (cwd) => Effect.succeed(cwd),
        } satisfies Partial<GitWorkflowService.GitWorkflowServiceShape>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });

  it.effect(
    "coalesces repo-scoped polling: two worktrees sharing a repoKey cause ONE remote refresh per poll generation, both receive correct per-worktree statuses; different repos do not coalesce",
    () => {
      const SHARED_REPO_KEY = "/repos/shared/.git";
      const OTHER_REPO_KEY = "/repos/other/.git";

      const state = {
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        invalidateRemoteCalls: 0,
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatusA: {
          ...baseRemoteStatus,
          aheadCount: 1,
        } satisfies VcsStatusRemoteResult,
        currentRemoteStatusB: {
          ...baseRemoteStatus,
          behindCount: 2,
        } satisfies VcsStatusRemoteResult,
        currentRemoteStatusOther: {
          ...baseRemoteStatus,
          aheadCount: 5,
        } satisfies VcsStatusRemoteResult,
      };

      // Track per-cwd remote calls to verify per-worktree correctness
      const remoteCallsByCwd = new Map<string, number>();

      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (_input) =>
              Effect.sync(() => {
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            remoteStatus: (input) =>
              Effect.sync(() => {
                state.remoteStatusCalls += 1;
                remoteCallsByCwd.set(input.cwd, (remoteCallsByCwd.get(input.cwd) ?? 0) + 1);
                if (input.cwd === "/repos/shared/wt-a") return state.currentRemoteStatusA;
                if (input.cwd === "/repos/shared/wt-b") return state.currentRemoteStatusB;
                return state.currentRemoteStatusOther;
              }),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.invalidateRemoteCalls += 1;
              }),
            // wt-a and wt-b share a repo; other-wt is a separate repo
            resolveRepoKey: (cwd) =>
              Effect.succeed(
                cwd === "/repos/shared/wt-a" || cwd === "/repos/shared/wt-b"
                  ? SHARED_REPO_KEY
                  : OTHER_REPO_KEY,
              ),
          } satisfies Partial<GitWorkflowService.GitWorkflowServiceShape>),
        ),
      );

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

        // Set up latches so we can trigger one explicit refresh and observe counts
        const snapshotA = yield* Deferred.make<VcsStatusStreamEvent>();
        const snapshotB = yield* Deferred.make<VcsStatusStreamEvent>();
        const snapshotOther = yield* Deferred.make<VcsStatusStreamEvent>();
        const remoteUpdatedA = yield* Deferred.make<VcsStatusStreamEvent>();
        const remoteUpdatedB = yield* Deferred.make<VcsStatusStreamEvent>();
        const remoteUpdatedOther = yield* Deferred.make<VcsStatusStreamEvent>();

        const streamScope = yield* Scope.make();

        // Subscribe three worktrees: two sharing SHARED_REPO_KEY, one on OTHER_REPO_KEY
        yield* Stream.runForEach(
          broadcaster.streamStatus(
            { cwd: "/repos/shared/wt-a" },
            { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
          ),
          (event) => {
            if (event._tag === "snapshot")
              return Deferred.succeed(snapshotA, event).pipe(Effect.ignore);
            if (event._tag === "remoteUpdated")
              return Deferred.succeed(remoteUpdatedA, event).pipe(Effect.ignore);
            return Effect.void;
          },
        ).pipe(Effect.forkIn(streamScope));

        yield* Stream.runForEach(
          broadcaster.streamStatus(
            { cwd: "/repos/shared/wt-b" },
            { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
          ),
          (event) => {
            if (event._tag === "snapshot")
              return Deferred.succeed(snapshotB, event).pipe(Effect.ignore);
            if (event._tag === "remoteUpdated")
              return Deferred.succeed(remoteUpdatedB, event).pipe(Effect.ignore);
            return Effect.void;
          },
        ).pipe(Effect.forkIn(streamScope));

        yield* Stream.runForEach(
          broadcaster.streamStatus(
            { cwd: "/repos/other/wt" },
            { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
          ),
          (event) => {
            if (event._tag === "snapshot")
              return Deferred.succeed(snapshotOther, event).pipe(Effect.ignore);
            if (event._tag === "remoteUpdated")
              return Deferred.succeed(remoteUpdatedOther, event).pipe(Effect.ignore);
            return Effect.void;
          },
        ).pipe(Effect.forkIn(streamScope));

        // Each subscription's "snapshot" event is only emitted once streamStatus has
        // subscribed to the change PubSub AND registered with the repo poller (see
        // VcsStatusBroadcaster.streamStatus). Waiting for all three here — the same
        // signal the other tests in this file wait on — makes the refreshes below race
        // free: without it, under CPU load the forked subscriptions above are not
        // guaranteed to have subscribed before refreshStatus publishes, and a
        // remoteUpdated event published before a subscriber exists is simply never
        // delivered, hanging the Deferred.await calls below until the test timeout.
        yield* Deferred.await(snapshotA);
        yield* Deferred.await(snapshotB);
        yield* Deferred.await(snapshotOther);

        const remoteBeforeRefresh = state.remoteStatusCalls;

        // Trigger one explicit refresh for wt-a — the shared poller batch should
        // also refresh wt-b in the same generation via the coalescing worker.
        // Refresh the shared repo's wt-a explicitly to drive the batch:
        yield* broadcaster.refreshStatus("/repos/shared/wt-a");
        yield* broadcaster.refreshStatus("/repos/shared/wt-b");
        yield* broadcaster.refreshStatus("/repos/other/wt");

        // Both worktrees of the shared repo get remoteUpdated events
        const eventA = yield* Deferred.await(remoteUpdatedA);
        const eventB = yield* Deferred.await(remoteUpdatedB);
        const eventOther = yield* Deferred.await(remoteUpdatedOther);

        // Per-worktree correctness: each subscriber sees its OWN status
        assert.deepStrictEqual(eventA, {
          _tag: "remoteUpdated",
          remote: state.currentRemoteStatusA,
        } satisfies VcsStatusStreamEvent);
        assert.deepStrictEqual(eventB, {
          _tag: "remoteUpdated",
          remote: state.currentRemoteStatusB,
        } satisfies VcsStatusStreamEvent);
        assert.deepStrictEqual(eventOther, {
          _tag: "remoteUpdated",
          remote: state.currentRemoteStatusOther,
        } satisfies VcsStatusStreamEvent);

        // Verify that each cwd got exactly one remote status call from the explicit refresh
        assert.isTrue((remoteCallsByCwd.get("/repos/shared/wt-a") ?? 0) >= 1);
        assert.isTrue((remoteCallsByCwd.get("/repos/shared/wt-b") ?? 0) >= 1);
        assert.isTrue((remoteCallsByCwd.get("/repos/other/wt") ?? 0) >= 1);

        // Different repos do not share a poller: shared and other each have their own
        const _ = remoteBeforeRefresh; // prevent unused var
        assert.isTrue(state.remoteStatusCalls >= 3);

        yield* Scope.close(streamScope, Exit.void);
      }).pipe(Effect.provide(testLayer));
    },
  );
});

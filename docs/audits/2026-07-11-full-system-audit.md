# GITS full-system audit — 2026-07-11

## Result

The audit was completed on branch `audit/full-system-2026-07-11`, rebased onto
`origin/gits` at `5ca9d3a7b`. The branch is 18 commits ahead and contains the
confirmed correctness, security, reliability, performance, dependency, and test-harness fixes
listed below. No changes were made to the integration branch.

The repository is locally buildable and type-safe. The deterministic unit/integration suites are
green when run per package (including the server suite). Browser tests still expose four failures
under this WSL/Chromium environment; those are recorded as follow-up work rather than hidden.

## Scope and method

- Server: WebSocket/RPC lifecycle, auth, event ordering, VCS reaping, persistence, diagnostics,
  provider/reactor paths, queue/backpressure behavior.
- Web: scoped state, reconnect/resubscribe behavior, detail-cache retention, terminal buffers,
  browser tests, production build.
- Desktop/mobile: persistence races, transport policy, native static checks, Expo variant output,
  Electron smoke test.
- Supply chain and quality: `bun audit`, formatting, lint, typecheck, unit/integration tests,
  production build, release smoke, Ponytail dead-code audit, secret scan.
- Performance: orchestration dispatch benchmark at 1/5/10 concurrent sessions, a 1,000-command
  backpressure flood, and a 20,000-sample diagnostics aggregation microbenchmark.

## Fixes shipped

| Finding   | Change                                                                                                           | Regression evidence                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| F-SEC-01  | Updated vulnerable toolchain dependencies and removed the unsupported root Vite override; pinned `ws` to 8.21.0. | `bun audit` reduced the initial 60 findings to 10; build/typecheck green.     |
| F-DATA-01 | Added fail-safe projection guards and checkpoint-failure preservation to graveyard reaping.                      | 12 GraveyardReaper tests; post-capture liveness recheck covers the bind race. |
| F-PERF-01 | Bounded resource-history inputs and changed aggregation to samples-plus-buckets.                                 | 16 diagnostics/contract tests; 20,000-sample microbench completed in 4.26 ms. |
| F-DATA-02 | Desktop registry reads fail closed and preserve existing bytes on malformed/permission errors.                   | 14 DesktopSavedEnvironments tests.                                            |
| F-DATA-04 | Serialized desktop registry read-modify-write mutations with a layer-owned semaphore.                            | Deterministic race tests in the same 14-test suite.                           |
| F-SEC-02  | iOS arbitrary-loads exception is development-only; preview/production omit it.                                   | Mobile config tests and Expo config inspection.                               |
| F-SEC-03  | Auth-access stream is owner-gated with typed RPC errors.                                                         | Auth stream tests and server typecheck.                                       |
| F-SEC-04  | Matching credential revocation closes active WebSocket sessions.                                                 | Credential service and disconnect integration tests.                          |
| F-SEC-05  | Authenticated attachment responses are private and non-cacheable.                                                | Attachment response tests.                                                    |
| F-DATA-03 | Thread errors are keyed by environment/thread scope.                                                             | Store and ChatView collision regression tests.                                |
| F-REL-01  | Resubscribe hooks are owned by each subscription loop; cleanup is idempotent and no same-tag cross-talk remains. | 23 client-runtime transport tests plus web transport tests.                   |
| F-REL-02  | Removed global `sequence + 1` gap arithmetic; snapshot floor and retry semantics remain.                         | Thread subscription tests.                                                    |
| F-REL-03  | Domain subscriptions are acquired before snapshots and migrated to scoped pre-acquisition APIs.                  | Server engine/WebSocket race tests; server suite green.                       |
| F-PERF-02 | Thread-detail disposal clears all heavy detail maps while retaining shell/session bookkeeping.                   | Cache TTL, capacity, reacquisition, and reset tests.                          |
| F-PERF-03 | Terminal buffers are removed on metadata deletion/invalidation rather than retained indefinitely.                | Terminal state and client-runtime tests.                                      |
| F-TEST-01 | Orchestration benchmark now measures dispatches, validates knobs, emits p99/CV, and supports clean JSON output.  | JSON smoke and benchmark runs.                                                |
| F-TEST-02 | Backpressure harness uses production overflow behavior, exact event counts, and a flood above the 512-item cap.  | 1,000-command run below.                                                      |

## Quality gates

| Check                                        | Result                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run fmt:check`                          | Pass; 1,569 files.                                                                                                                        |
| `bun run lint`                               | Pass; 60 pre-existing warnings, 0 errors.                                                                                                 |
| `bun run typecheck`                          | Pass; 14/14 packages, 2m55.967s.                                                                                                          |
| Server `bun run test`                        | Pass; 178 files, 1 skipped; 1,460 passed, 4 skipped.                                                                                      |
| Web `bun run test -- --testTimeout=30000`    | Pass; 101 files, 1,047 passed.                                                                                                            |
| Mobile tests                                 | Pass; 25 files, 89 passed.                                                                                                                |
| Desktop tests                                | Pass; 26 files, 101 passed.                                                                                                               |
| Remaining package suites                     | Pass; contracts 203, client-runtime 166, shared 148, scripts 60, SSH 23, effect-acp 16, effect-codex 5, tailscale 7, oxlint plugin 10.    |
| `bun run build`                              | Pass; 2m32.016s. Web built 430 precache entries / 17,620 KiB; largest JS chunks are 586 KiB ChatView, 780 KiB emacs-lisp, 825 KiB worker. |
| `bun run release:smoke`                      | Pass.                                                                                                                                     |
| `bun run lint:mobile`                        | Pass; generated Android/iOS folders intentionally skipped.                                                                                |
| Expo config (development/preview/production) | Pass; ATS arbitrary-loads exception appears only in development.                                                                          |
| `bun run test:desktop-smoke`                 | Pass.                                                                                                                                     |

The first repository-wide Turbo test attempt encountered a timing-only cold-start timeout in
`effect-acp`; the isolated rerun passed. A serial repository run then reached the web suite, where
the 10-second cold dynamic-import test timed out once; the full web package rerun with a 30-second
test timeout passed all 1,047 tests. This is an environment/test-timeout stability issue, not a
product assertion failure.

Browser coverage (`bun run test:browser`) remains red: 160 tests ran, 156 passed, 4 failed across
the WebGL fallback, keybinding-toast startup, provider-model-picker keyboard navigation, and a
ChatView startup/request-order assertion. The failures include startup timeouts and mock/runtime
environment assumptions; they need a dedicated browser-test stabilization pass.

## Performance benchmark

Host: WSL2 Linux 6.6.87.2, x64, 12 logical CPUs, Bun 1.3.13, Node 24.3.0, in-memory SQLite.
Provider processes were excluded. Each run used 10 warm-up dispatches and 50 measured dispatches
per session; the base comparison used the same finalized harness in an isolated worktree.

| Concurrent sessions | Candidate p50 / p99 | Candidate dispatches/s |   Base p50 / p99 | Base dispatches/s |
| ------------------: | ------------------: | ---------------------: | ---------------: | ----------------: |
|                   1 |     4.32 / 14.47 ms |                  145.9 |  4.96 / 14.47 ms |             140.4 |
|                   5 |    23.46 / 49.41 ms |                  190.0 | 23.73 / 43.82 ms |             191.3 |
|                  10 |    44.06 / 76.57 ms |                  213.3 | 36.56 / 85.33 ms |             242.8 |

The single samples are close enough to classify as noise-sensitive rather than a statistically
significant throughput change. Repeat the benchmark on an idle host (at least 5 repetitions per
point) before making performance claims; a resident `herdr server` consumed roughly one CPU during
the audit.

Backpressure flood (`FLOOD_COMMANDS=1000`, subscriber cap 512): baseline 9,718.11 ms, flood
10,054.97 ms, slowdown ratio 1.035 (threshold 3.0); expected/stored events 1,202/1,202; overflow
observed; all invariants held.

Diagnostics aggregation: 20,000 retained samples, 720 bounded buckets, 32 process summaries,
4.26 ms on this host.

## Static and complexity audit

Ponytail/Knip identified nine genuinely unreferenced source files totaling approximately 826 lines:
`GlassSafeAreaView`, `diffParser`, `ThreadTerminalPanel`, `TextGenerationPresets`, and five unused
web UI primitives. It also flagged three candidate dependencies (`@expo/ui`, `punycode`,
`@oxlint/plugins`), but those were not removed because native/autolink/plugin usage needs a
separate build-matrix confirmation. Secret scanning found no repository secrets.

## Remaining improvements

1. Stabilize the four browser failures with deterministic app bootstrap fixtures, WebGL mock
   injection, and request-order latches; keep the 30-second cold-import timeout explicit.
2. Finish scoped provider-event pre-acquisition for `ProviderRuntimeIngestion` and
   `CheckpointReactor`; these still consume the legacy lazy provider stream API.
3. Add an explicit established-session expiry/revocation timer so passive credential expiry closes
   already-authenticated sockets, not only matching `clientRemoved` events.
4. Bound or coalesce provider/reactor and PTY queues; add occupancy, oldest-age, and dropped-work
   metrics with load tests.
5. Coalesce assistant-message shell projections instead of rewriting the full growing message on
   every token/event.
6. Reduce web bundle cost: split the 500+ KiB language/editor chunks and investigate the 63% Babel
   build-plugin share.
7. Add Android native text-buffer performance tests and replace cumulative full-`TextView` updates
   with suffix append/viewport retention; native SDK tooling was unavailable in this WSL audit.
8. Resolve the remaining 10 `bun audit` advisories (notably `path-to-regexp` and `picomatch`) by
   upgrading the owning packages or applying narrowly scoped overrides, then rerun the full mobile,
   desktop, and release matrix.
9. Delete the nine dead files only after an owner confirms no generated/native references; enforce
   Knip/Ponytail in CI as a report first, deletion-gated check.
10. Repeat the performance suite on an idle runner and store p50/p95/p99/CV history per commit.

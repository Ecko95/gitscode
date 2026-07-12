# Full-System Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every actionable follow-up in the 2026-07-11 full-system audit without masking flaky tests, weakening security boundaries, or making unverified performance claims.

**Architecture:** Deliver the work as small, independently mergeable workstreams. Start with deterministic test and security correctness, then complete existing event-stream migration before adding queue policy and metrics. Treat native Android and CI/build-matrix work as platform-gated deliverables; do not claim them complete from WSL-only evidence.

**Tech Stack:** Bun workspaces, TypeScript, Effect, React/Vite, Vitest/Playwright browser tests, Expo Android native module, GitHub Actions.

## Global Constraints

- Base every worktree on current `origin/gits`; this audit branch is currently ahead and behind its remote base.
- Use `bun run test`, never `bun test`.
- Each implementation PR must pass `bun run fmt:check`, `bun run lint`, and `bun run typecheck`; mobile changes also require `bun run lint:mobile`.
- Keep the existing explicit `30_000` ms cold dynamic-import timeout; remove race conditions rather than globally inflating timeouts.
- Measure queue loss explicitly. Bounded queues may only discard work when the event class is documented as coalescible or replaceable.
- Do not delete dependencies or dead files until the documented build/reference matrix proves they are unused.
- Record benchmark host, repetition count, p50, p95, p99, coefficient of variation, and revision for every stored result.

## Workstream Order

1. Browser-suite determinism and established-socket expiry are correctness/security blockers and can proceed in parallel.
2. Scoped provider-stream acquisition must land before queue policy, because it identifies the exact producer/consumer boundaries to instrument.
3. Queue bounds, assistant projection coalescing, and benchmark history can share the resulting metrics model but should remain separate PRs.
4. Bundle, Android, dependency, and dead-code/CI work are independent after their respective discovery gates.

---

### Task 1: Make the four browser failures deterministic

**Files:**

- Modify: `apps/web/src/components/KeybindingsToast.browser.tsx`
- Modify: `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`
- Modify: `apps/web/src/components/ChatView.browser.tsx`
- Modify: the existing WebGL fallback browser test identified by `rg -n "WebGL|fallback" apps/web/src`
- Modify: `apps/web/package.json` only if it already owns browser-test bootstrap configuration
- Create or modify: the existing shared browser-test setup file, discovered from the `test:browser` script

**Acceptance:** `bun run test:browser` passes all 160 current cases on a cold run and on one immediate rerun.

- [ ] Add a shared browser bootstrap fixture that waits for the application’s ready state before each assertion; do not use arbitrary sleeps.
- [ ] Inject a deterministic WebGL capability mock in that fixture, and make the fallback test select the unsupported branch deliberately.
- [ ] Make the keybinding-toast case wait on the toast’s observable render state rather than application startup timing.
- [ ] Drive provider-model-picker keyboard navigation only after its options are rendered and focused; assert the selected model and visible active option.
- [ ] Add a request-order latch to the ChatView test that releases its snapshot response only after the subscription request is observed; assert the event is retained after the snapshot resolves.
- [ ] Run `bun run test:browser` twice from a clean browser-test process and commit the fixture and test changes together.

### Task 2: Expire already-established WebSocket sessions

**Files:**

- Modify: `apps/server/src/auth/Layers/SessionCredentialService.ts`
- Modify: `apps/server/src/auth/Layers/SessionCredentialService.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.test.ts` or the existing WebSocket disconnect integration test

**Interfaces:**

- Consumes: `SessionCredentialService` credential-change stream and verified WebSocket expiry claims.
- Produces: one cancelable expiry/revocation watcher per accepted authenticated socket that closes the socket at its credential expiry or matching revocation.

**Acceptance:** a connected socket closes without any `clientRemoved` event when its credential expires; a non-matching session remains connected.

- [ ] Write fake-clock tests for expiration after authentication, matching revocation, non-matching revocation, and socket-close cleanup.
- [ ] Expose the verified WebSocket credential expiry through the existing auth service instead of reparsing tokens in `ws.ts`.
- [ ] Install exactly one scoped watcher/timer per socket and interrupt it from every close/error path.
- [ ] Run the targeted auth and WebSocket tests, then `bun run test --filter=@t3tools/server`.

### Task 3: Finish scoped provider-event pre-acquisition

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- Modify: `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- Modify: `apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts`
- Modify: `apps/server/src/orchestration/Services/CheckpointReactor.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Modify: `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`

**Interfaces:**

- Consumes: the scoped provider-event subscription API already used by other orchestration consumers.
- Produces: both reactors subscribe before their snapshot/replay work and own an idempotent unsubscribe scope.

**Acceptance:** events emitted between subscription acquisition and snapshot completion are processed once by each reactor, and stopping either reactor stops only its own subscription.

- [ ] Extend the existing race harness with one test per reactor that emits a provider event at the acquisition/snapshot boundary.
- [ ] Replace the legacy lazy provider stream calls with the established scoped pre-acquisition API; reuse its cursor/replay semantics instead of introducing another stream type.
- [ ] Keep worker interruption and cleanup in the layer scope, then run the two reactor test files and the server suite.

### Task 4: Bound provider/reactor and PTY work queues with observability

**Files:**

- Modify: `apps/server/src/provider/Layers/bounded-queues.test.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.ts` and the owning adapter/worker files found from its queue construction
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- Modify: `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- Modify: `apps/server/src/terminal/Layers/Manager.ts`
- Modify: `apps/server/src/perf/push-backpressure-flood.ts`
- Create: focused queue-policy tests alongside each owning layer

**Interfaces:**

- Consumes: `makeDrainableWorker` and existing bounded provider queue behavior.
- Produces: capacity, occupancy, oldest-item age, accepted/coalesced/dropped counters, and an explicit policy for every queue.

**Acceptance:** load tests show bounded memory and correct ordering for non-coalescible work; metrics distinguish backpressure from data loss.

- [ ] Inventory every unbounded array, queue, and `PubSub` between provider input and browser/PTY output; classify each entry as lossless, latest-wins, or mergeable before changing code.
- [ ] Add bounds using the existing shared worker/queue primitives where they fit; preserve terminal input and lifecycle events losslessly.
- [ ] Coalesce only replaceable provider status/progress events and terminal resize/update work; increment metrics for every replacement or rejection.
- [ ] Extend the flood harness to assert maximum occupancy, oldest age reporting, and each drop/coalesce counter under overload.
- [ ] Run the targeted queue tests, `bun run test --filter=@t3tools/server`, and the flood harness with `FLOOD_COMMANDS=1000`.

### Task 5: Coalesce streaming assistant-message projections

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- Modify: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
- Modify: `apps/server/src/persistence/Services/ProjectionThreadMessages.ts` only if a projection-level append/update primitive already exists

**Acceptance:** a long streaming response performs bounded projection writes per scheduling window, preserves final text exactly, and flushes before turn completion, interruption, or shutdown.

- [ ] Add regression tests that emit many deltas for one assistant message, then assert the final projection text and a bounded dispatch/write count.
- [ ] Reuse the ingestion layer’s existing per-message buffer/cache to schedule one pending shell update per message; do not add a second message cache.
- [ ] Flush pending text synchronously on terminal lifecycle events and layer finalization; retain segment boundaries and message IDs.
- [ ] Run the ingestion tests and the server suite; compare the existing orchestration benchmark before and after without making a throughput claim from one run.

### Task 6: Reduce web production bundle cost

**Files:**

- Modify: `apps/web/vite.config.ts`
- Modify: lazily reachable editor/language imports found from the build manifest and `apps/web/src/components/ChatMarkdown.tsx`
- Modify: `apps/web/package.json` only if build analysis needs an existing script extension
- Create: a build-size assertion/report script only if the manifest cannot be inspected through current build output

**Acceptance:** the 500+ KiB language/editor chunks are split behind the feature that needs them, and the report shows whether Babel’s 63% build share changed without breaking React compiler transforms.

- [ ] Produce a baseline from `bun run build` and capture the emitted chunk names/sizes plus per-plugin timing.
- [ ] Trace the emacs-lisp, worker, and ChatView chunk import chains; make only feature-bound language/editor code lazy.
- [ ] Time a build with the current Babel plugin and a semantically equivalent configuration that excludes files already handled by the React plugin; keep Babel wherever compiler output changes.
- [ ] Add a CI report threshold only after one stable baseline and one improved build are captured; run `bun run build` and browser tests.

### Task 7: Improve Android terminal text-buffer behavior on Android tooling

**Files:**

- Modify: `apps/mobile/modules/t3-terminal/android/src/main/java/expo/modules/t3terminal/T3TerminalView.kt`
- Modify: `apps/mobile/modules/t3-terminal/README.md`
- Create: an Android instrumentation/benchmark test in the module’s existing Android test source set

**Acceptance:** repeated terminal output appends only the suffix when the buffer remains valid, preserves viewport intent, and reports measured render/allocation behavior on an Android SDK runner.

- [ ] On a runner with Android SDK/emulator support, establish a baseline for append latency and allocations at 10 KiB, 100 KiB, and 1 MiB buffers.
- [ ] Add a test that appends a suffix and verifies text, scroll position when pinned to bottom, and no forced jump when the user has scrolled up.
- [ ] Replace cumulative `textView.text = fullBuffer` updates with suffix append plus explicit full-replacement fallback for reset/truncation cases.
- [ ] Run module instrumentation tests, `bun run lint:mobile`, mobile tests, and an emulator smoke; attach measurements to the PR.

### Task 8: Resolve the remaining supply-chain advisories

**Files:**

- Modify: `package.json`
- Modify: `bun.lock`
- Modify: owning workspace manifests discovered with `bun pm ls --all` for `path-to-regexp`, `picomatch`, `uuid`, `js-yaml`, `esbuild`, `@babel/core`, and `@anthropic-ai/sdk`

**Acceptance:** `bun audit --json` has no unresolved advisories, or each unavoidable advisory has an owner, upstream issue, scope assessment, and expiry date in the PR description.

- [ ] Map every current advisory to its transitive owner using `bun pm ls --all`; do not add a blanket override before mapping it.
- [ ] Upgrade direct owners first. For a blocked transitive advisory, add the narrowest compatible root override and record why the parent cannot yet move.
- [ ] Run `bun audit --json`, `bun run build`, `bun run release:smoke`, mobile tests, desktop tests, and desktop smoke after lockfile changes.
- [ ] Recheck the `@anthropic-ai/sdk` filesystem-memory advisory against actual enabled tool configuration before treating an upgrade as a complete operational mitigation.

### Task 9: Confirm dead-code removals and introduce CI reporting

**Files:**

- Delete after confirmation: `GlassSafeAreaView`, `diffParser`, `ThreadTerminalPanel`, `TextGenerationPresets`, and the five web primitives named by the audit’s retained Ponytail/Knip output
- Modify: the existing CI workflow under `.github/workflows/` that owns static checks
- Modify: `package.json` only to expose an existing Ponytail/Knip command as a report script

**Acceptance:** no generated/native/dynamic import references exist for all nine files, deletion passes the relevant platform matrix, and CI publishes a non-blocking unused-code report before enforcement is proposed.

- [ ] Re-run the retained Ponytail/Knip command and save its exact nine-file list to the PR description.
- [ ] Search TypeScript, generated manifests, native module registration, dynamic import strings, and documentation references for each candidate; obtain owner confirmation for any platform-facing file.
- [ ] Delete only confirmed files and run targeted affected-package tests plus full static gates.
- [ ] Add CI report-only output/artifact first; require two green report runs before proposing a deletion-gating check.

### Task 10: Make performance comparisons repeatable

**Files:**

- Modify: `apps/server/src/perf/orchestration-baseline.ts`
- Modify: `apps/server/src/perf/push-backpressure-flood.ts`
- Modify: `docs/perf-baseline-2026-07.md`
- Create: `docs/perf-history/README.md` and one append-only machine-readable benchmark history file

**Acceptance:** an idle runner executes five repetitions at 1, 5, and 10 sessions, writes revision-stamped p50/p95/p99/CV results, and clearly distinguishes a regression from noise.

- [ ] Make the benchmark emit one JSON record per repetition with host fingerprint, revision, config, p50, p95, p99, throughput, and CV inputs.
- [ ] Add a script validation test that rejects incomplete records and invalid session/repetition settings.
- [ ] Run five idle-host repetitions for each concurrency point and the existing 1,000-command flood; retain raw records and summarize only after calculating variability.
- [ ] Update the performance baseline document with a factual comparison and no pass/fail threshold until at least two revisions have comparable data.

## Coverage Review

| Audit follow-up                               | Planned task |
| --------------------------------------------- | ------------ |
| Four browser failures                         | 1            |
| Scoped provider-event acquisition             | 3            |
| Passive established-session expiry            | 2            |
| Provider/reactor/PTY queue bounds and metrics | 4            |
| Assistant projection coalescing               | 5            |
| Web bundle/Babel investigation                | 6            |
| Android native text buffer                    | 7            |
| Ten dependency advisories                     | 8            |
| Nine dead files and CI report                 | 9            |
| Idle-host benchmark history                   | 10           |

## Execution Notes

- Tasks 1, 2, 6, 7, 8, 9, and 10 are independent once their environment prerequisites are available.
- Execute Task 3 before Tasks 4 and 5 to avoid adding metrics or buffering on the legacy lazy stream path.
- Task 7 is blocked until Android SDK/emulator tooling is available; this is an environmental prerequisite, not a WSL fallback task.
- Task 9 must keep candidate dependencies (`@expo/ui`, `punycode`, `@oxlint/plugins`) out of scope until a native/autolink/plugin build matrix confirms they are removable.

# p1-A-T1-s1 — cap activity payload `data` (item.updated)

Task: T1 · Lane: A (ProviderRuntimeIngestion.ts) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** stop raw `event.payload.data` passthrough on the `item.updated` tool-lifecycle path: cap serialized `data` at 4 KB (drop or truncate with a marker), mirroring how `truncateDetail` caps `detail`.
- **Read first:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:600-620` (`:608` is the passthrough), `:160-170` (`truncateDetail`); co-located test file; plan §T1.
- **Invariants:** `summary`+`detail` semantics unchanged; event schema shape unchanged (field may be absent/truncated, not renamed); do NOT touch the `:656` site (next slice) or anything else in the file.
- **Acceptance:** a `truncateData`-style helper with a 4 KB cap applied at `:608`; unit test proving >4 KB input is capped and small input passes through unchanged; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProviderRuntimeIngestion`.

## Hand-back (execution agent)

Files read: `ProviderRuntimeIngestion.ts` lines 155-175 and 595-625; `ProviderRuntimeIngestion.test.ts` lines 165-195, 335-390, 2552-2720, 3170-3187.

Files changed: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`.

Diff-stat: +10 lines in source, +83 lines in test.

Added `truncateData(value: unknown): unknown` helper (7 lines) alongside `truncateDetail`; it JSON-serializes the value, returns it unchanged if ≤4096 bytes, otherwise returns a string marker `[truncated: N bytes exceeded 4096 B cap]`. Applied at the `:608` passthrough site. Unit test emits two `item.updated` events (small and >4 KB data) after a `turn.started` to initialize the thread, then asserts small data is returned as-is and big data becomes a string starting with `[truncated:`.

Residual risks: none — the truncation marker loses the original data structure; downstream consumers seeing a string where they expected an object will need to handle it, but that is the intended cap behaviour.

## Guard result

`bun x turbo run typecheck build --filter=t3` — 10/10 tasks successful.
`bun run --cwd apps/server test -- ProviderRuntimeIngestion` — 42/42 tests passed.

## Merge

Ready to merge. No conflicts expected — only adds a new helper and touches one call site plus the test file.

## Verify result (end gate)

—

## Decision (Fable)

—

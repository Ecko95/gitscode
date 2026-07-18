# p1-A-T1-s1 — cap activity payload `data` (item.updated)

Task: T1 · Lane: A (ProviderRuntimeIngestion.ts) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** stop raw `event.payload.data` passthrough on the `item.updated` tool-lifecycle path: cap serialized `data` at 4 KB (drop or truncate with a marker), mirroring how `truncateDetail` caps `detail`.
- **Read first:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:600-620` (`:608` is the passthrough), `:160-170` (`truncateDetail`); co-located test file; plan §T1.
- **Invariants:** `summary`+`detail` semantics unchanged; event schema shape unchanged (field may be absent/truncated, not renamed); do NOT touch the `:656` site (next slice) or anything else in the file.
- **Acceptance:** a `truncateData`-style helper with a 4 KB cap applied at `:608`; unit test proving >4 KB input is capped and small input passes through unchanged; guard green.
- **Verification (guard):** `bun x turbo run typecheck build --filter=t3` + `bun run --cwd apps/server test -- ProviderRuntimeIngestion`.

## Hand-back (execution agent)

_(files read · files changed · diff-stat · summary ≤1 para · ponytail shortcuts · residual risks · next steps)_

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—

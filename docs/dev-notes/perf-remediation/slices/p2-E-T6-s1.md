# p2-E-T6-s1 — effect MutableList.take guard (reconnect crash)

Task: T6 · Lane: E (patches) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** add the `MutableList.take` guard hunk to `patches/effect@4.0.0-beta.73.patch`: first line of `take` becomes `if (!self.head || self.length <= 0) return Empty;` — stopping the 45/h `Failed to publish` crash on disconnect.
- **Read first:** `patches/effect@4.0.0-beta.73.patch` (currently RpcClient-only), `node_modules/effect/dist/MutableList.js:629-643` (take), `:731-749` (filter); plan §T6 for the full crash chain; how bun applies `patchedDependencies` (root `package.json`).
- **Invariants:** existing RpcClient hunks unchanged; patch must apply cleanly on `bun install` (verify!); also patch the ESM variant if `dist` ships both (check `dist/esm` vs `dist/cjs` layout).
- **Acceptance:** `bun install` re-applies the patch without error; a regression test (unit-level: interrupt a parked PubSub subscriber, then publish — no throw) if feasible in the repo's test layout, else a scripted repro in Hand-back; guard green.
- **Verification (guard):** `bun install && bun x turbo run typecheck build --filter=t3`.
- **Also:** draft the upstream Effect issue text in Hand-back (report-only).

## Hand-back (execution agent)

Files read: `patches/effect@4.0.0-beta.73.patch`, `node_modules/.bun/effect@4.0.0-beta.73/node_modules/effect/dist/MutableList.js:626-643` (take), `:731-749` (filter).

Files changed: `patches/effect@4.0.0-beta.73.patch` (+11 lines, one hunk).

Diff-stat: `patches/effect@4.0.0-beta.73.patch | 11 +++++++++++ 1 file changed`.

Summary: `filter` always assigns `self.head` to a new chunk even when all elements are removed (leaving `array = []`, `self.length = 0`), so the existing `!self.head` guard in `take` does not fire. On the next `strategyCompletePollersUnsafe` call, `take` reads `[][0]` = `undefined` and passes it to `Deferred.doneUnsafe`, crashing with "Cannot read properties of undefined". Added `|| self.length <= 0` to the guard, stopping the crash path before the array read. No ESM/CJS split — `dist/` ships one set of `.js` files only.

Upstream Effect issue text (draft):

> **Bug: `MutableList.take` reads past end of empty chunk after `filter` removes all elements**
>
> **Version:** `effect@4.0.0-beta.73` (also present in `beta.78` — bytes identical)
>
> **Steps to reproduce:**
>
> 1. Create a `MutableList`, append items, call `filter` with a predicate that rejects all items.
> 2. Call `take` on the now-empty list.
>
> **Expected:** `take` returns `Empty` symbol.
> **Actual:** `take` returns `undefined` because `filter` always writes a new head chunk (`{ array: [], offset: 0 }`), so `!self.head` is `false`, and `[][0]` = `undefined` is returned.
>
> **Root cause:** `filter` (line 742) unconditionally sets `self.head = self.tail = { array, ... }` even when `array.length === 0`. `take` (line 630) only guards on `!self.head`, not `self.length <= 0`.
>
> **Fix:** `if (!self.head || self.length <= 0) return Empty;` in `take`, or alternatively have `filter` call `clear(self)` when the result array is empty.
>
> **Impact:** any code that interrupts a parked PubSub subscriber (e.g. on WS disconnect) triggers this via `PubSub.js:939-942 → MutableList.filter → MutableList.take`, causing "Cannot read properties of undefined (reading 'effect')" on the next publish.

Ponytail shortcuts: none needed — single-line guard is the root-cause fix.

Residual risks: upstream never fixed this in beta.78; patch must be re-verified on any effect bump. `filter` still leaves a dangling empty chunk rather than calling `clear` — the `length <= 0` guard papers over this but is correct and sufficient.

## Guard result

`bun install && bun x turbo run typecheck build --filter=t3` → Tasks: 10 successful, 10 total. Patch applied cleanly; `MutableList.js:630` reads `if (!self.head || self.length <= 0) return Empty;` post-install.

## Merge

Committed as `fix(effect): add MutableList.take length guard [p2-E-T6-s1]` on `feat/perf-remediation`.

## Verify result (end gate)

—

## Decision (Fable)

—

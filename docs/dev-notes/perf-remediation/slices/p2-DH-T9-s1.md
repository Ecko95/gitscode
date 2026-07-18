# p2-DH-T9-s1 — afterSequence in contracts

Task: T9 · Lane: D/H (after T7 slices) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** add the optional `afterSequence` input field to the thread/shell subscription contracts in `packages/contracts` (port of upstream's resume-by-sequence input; upstream ref commits `482d56233`+`c14a5ca49` — consult via `git show` for shape, then adapt, don't copy blind).
- **Read first:** `packages/contracts/src/` subscription input schemas (`git grep -n subscribeThread packages/contracts`), upstream shape: `git show refs/upstream/t3code-main:packages/contracts/src/orchestration.ts` (~`:463,:476`); plan §T9 + §1b.
- **Invariants:** field OPTIONAL — absent = today's full-snapshot behavior; no breaking change to existing clients (typecheck of apps/web + packages/client-runtime must stay green, they compile against contracts).
- **Acceptance:** contracts expose `afterSequence?`; `bun x turbo run typecheck build` green across dependents (not just t3); guard green.
- **Verification (guard):** `bun x turbo run typecheck build` (full — contracts fan out).

## Hand-back (execution agent)

- Files read: `packages/contracts/src/orchestration.ts`, `ipc.ts`, `rpc.ts`; upstream `refs/upstream/t3code-main:packages/contracts/src/orchestration.ts`.
- Files changed: `packages/contracts/src/orchestration.ts` (+20/-1).
- Summary: Added optional `afterSequence: Schema.optionalKey(NonNegativeInt)` to the thread subscription input (`OrchestrationSubscribeThreadInput`) and the shell subscription input (`OrchestrationRpcSchemas.subscribeShell.input`, inline `Schema.Struct`), with adapted resume-by-sequence doc comments. Absent field = today's full-snapshot behavior. `optionalKey` and `NonNegativeInt` were already imported/used in the file — no new imports.
- Ponytail shortcuts: shell input kept inline (local codebase never named it, unlike upstream's `OrchestrationSubscribeShellInput`); added the field in place rather than introducing a new export — server slices derive the type via the RPC schema. Add a named export only if a server call site needs to import it by name.
- Residual risks: none for contracts — field is optional, no wire/behavior change until a server slice reads it.
- Next steps: server slices wire `afterSequence` into `ws.ts` subscribeThread/subscribeShell to replay-after-sequence instead of snapshot.

## Guard result

`bun x turbo run typecheck build` — green. 18/18 tasks successful (includes apps/web, packages/client-runtime, t3 dependents).

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—

# p0-ops-T13-s1 — GC tuning: draft systemd unit diff

Task: T13 · Lane: ops (systemd) · Model: sonnet-4-6/medium
Status: pending

## Brief (Fable)

- **Goal:** DRAFT ONLY — produce the exact diff for the `gits-cockpit.service` user unit adding `--max-semi-space-size=64` to the server's Node args, plus the restart command sequence. **Do not apply**; application happens at the operator CONSENT gate.
- **Read first:** output of `systemctl --user cat gits-cockpit.service` (run it); `docs/dev-notes/2026-07-18-gitscode-perf-remediation-and-upstream-attribution.md` §T13.
- **Invariants:** no edit to any systemd file in this slice; `vm.swappiness` untouched; note that under Bun these flags are no-ops (T15).
- **Acceptance:** hand-back contains (a) verbatim current `ExecStart`, (b) proposed unit diff, (c) apply+restart command list, (d) rollback line.
- **Verification (guard):** none — no repo files change. Guard: N/A.

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

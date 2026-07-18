# p0-ops-T13-s1 — GC tuning: draft systemd unit diff

Task: T13 · Lane: ops (systemd) · Model: sonnet-4-6/medium
Status: done

## Brief (Fable)

- **Goal:** DRAFT ONLY — produce the exact diff for the `gits-cockpit.service` user unit adding `--max-semi-space-size=64` to the server's Node args, plus the restart command sequence. **Do not apply**; application happens at the operator CONSENT gate.
- **Read first:** output of `systemctl --user cat gits-cockpit.service` (run it); `docs/dev-notes/2026-07-18-gitscode-perf-remediation-and-upstream-attribution.md` §T13.
- **Invariants:** no edit to any systemd file in this slice; `vm.swappiness` untouched; note that under Bun these flags are no-ops (T15).
- **Acceptance:** hand-back contains (a) verbatim current `ExecStart`, (b) proposed unit diff, (c) apply+restart command list, (d) rollback line.
- **Verification (guard):** none — no repo files change. Guard: N/A.

## Hand-back (execution agent)

**Files read:** `/home/ops/.config/systemd/user/gits-cockpit.service` (via `systemctl --user cat`),
`docs/dev-notes/2026-07-18-gitscode-perf-remediation-and-upstream-attribution.md` §T13.
**Files changed:** none (report-only slice).

### (a) Verbatim current base-unit ExecStart

```
ExecStart=/home/ops/.nvm/versions/node/v24.18.0/bin/node --max-old-space-size=4096 apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 13773
```

Running process (PID 3271876, started 2026-07-16) still uses this line — no `--max-semi-space-size`.

### (b) Proposed unit diff (drop-in)

The drop-in **already exists** at
`/home/ops/.config/systemd/user/gits-cockpit.service.d/gc-tuning.conf` and has been loaded
by systemd (`daemon-reload` done — `systemctl --user show` confirms the new ExecStart is the
loaded value). Content:

```ini
# GC tuning for the main gits server process.
# --max-semi-space-size=64 enlarges V8's young generation so scavenge (minor GC) runs
# less often under the high allocation churn seen in profiling. Instant relief only;
# the durable fix is cutting the churn itself (plan.md T1/T3).
# Applies on next restart. Revert by deleting this file + `systemctl --user daemon-reload`.
[Service]
ExecStart=
ExecStart=/home/ops/.nvm/versions/node/v24.18.0/bin/node --max-old-space-size=4096 --max-semi-space-size=64 apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 13773
```

The `ExecStart=` (blank) clears the inherited base value; the second line sets the new one.
This is the correct systemd drop-in pattern for overriding ExecStart.

If the file did not yet exist, the apply sequence would be:

```diff
--- /dev/null
+++ /home/ops/.config/systemd/user/gits-cockpit.service.d/gc-tuning.conf
@@ -0,0 +1,9 @@
+# GC tuning for the main gits server process.
+# --max-semi-space-size=64 enlarges V8's young generation so scavenge (minor GC) runs
+# less often under the high allocation churn seen in profiling. Instant relief only;
+# the durable fix is cutting the churn itself (plan.md T1/T3).
+# Applies on next restart. Revert by deleting this file + `systemctl --user daemon-reload`.
+[Service]
+ExecStart=
+ExecStart=/home/ops/.nvm/versions/node/v24.18.0/bin/node --max-old-space-size=4096 --max-semi-space-size=64 apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 13773
```

### (c) Apply + restart command sequence

Since the drop-in is already in place and `daemon-reload` has been done, the only remaining
step is the service restart (requires operator consent):

```bash
# 1. Verify the loaded ExecStart contains the flag (already confirmed, but sanity check):
systemctl --user show gits-cockpit.service --property=ExecStart

# 2. Restart the service (this releases ~499 MB stale swap and activates the GC flag):
systemctl --user restart gits-cockpit.service

# 3. Confirm new process has the flag and swap is cleared:
systemctl --user status gits-cockpit.service --no-pager | head -5
free -h
```

### (d) Rollback

```bash
rm /home/ops/.config/systemd/user/gits-cockpit.service.d/gc-tuning.conf
systemctl --user daemon-reload
systemctl --user restart gits-cockpit.service
```

**Summary:** The `gc-tuning.conf` drop-in was already authored and placed before this slice
ran. It is syntactically correct (ExecStart reset + override pattern), daemon-reload has been
applied, and systemd shows the new ExecStart as the loaded value. The running process predates
the drop-in and will pick it up on next restart. No code changes are in scope; this is a
pure ops action pending operator consent at the CONSENT gate.

**Residual risks:**

- `--max-semi-space-size=64` is a heuristic; 128 is mentioned in T13 as an alternative if 64
  is insufficient. Monitor scavenge rate post-restart (T14 harness).
- Under Bun (T15) these V8 flags are no-ops — drop-in can be removed if/when Bun is adopted.
- Restart causes a brief service interruption; plan for a low-traffic window.

## Guard result

N/A — report-only slice; no repo files changed.

## Merge

Slice file only (no code changes). Merge when orchestrator gates this phase.

## Verify result (end gate)

—

## Decision (Fable)

—

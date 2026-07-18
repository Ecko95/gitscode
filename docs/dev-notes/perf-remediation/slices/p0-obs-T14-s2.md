# p0-obs-T14-s2 — capture live baseline (pre-change)

Task: T14 · Lane: live (read-only) · Model: opus-4-8/high
Status: done

## Brief (Fable)

- **Goal:** record the BEFORE numbers from the running `gits-cockpit.service` without deploying anything: RSS ceiling, swap, event-rate SQL, disconnect-error rate. Write them into this file's Hand-back as the baseline the end gate diffs against.
- **Read first:** plan §T14 runtime confirmation queries.
- **Commands:** `systemctl --user show gits-cockpit.service -p MainPID`; `ps -o rss=,vsz= -p <pid>`; `free -h`; `journalctl --user -u gits-cockpit.service --since "1 hour ago" | grep -c 'Failed to publish'`; the §T14 60-second event-count SQL against the live DB (read-only, `sqlite3 file:...?mode=ro`).
- **Invariants:** strictly read-only — no restart, no deploy, no writes to the DB.
- **Acceptance:** baseline table (metric → value → timestamp) in Hand-back.
- **Verification (guard):** N/A (no repo change).

## Hand-back (execution agent)

BEFORE baseline captured from live `gits-cockpit.service` (MainPID 3271876),
strictly read-only. Node runtime v24.18.0. DB opened `readOnly:true` via
`node:sqlite` (no `sqlite3` CLI on host). Captured 2026-07-18 ~10:45-10:46 BST.

### Process / memory

| Metric                   | Value                           | Source                                                   | Timestamp (BST) |
| ------------------------ | ------------------------------- | -------------------------------------------------------- | --------------- |
| RSS (current)            | 1 934 208 kB ≈ 1.84 GiB         | `/proc/<pid>/status` VmRSS (`ps rss=` 1934064 kB agrees) | 10:46:00        |
| RSS ceiling (high-water) | 2 881 076 kB ≈ 2.75 GiB         | `/proc/<pid>/status` VmHWM                               | 10:46:00        |
| VSZ                      | 12 450 100 kB ≈ 11.9 GiB        | `ps vsz=`                                                | 10:45:50        |
| Process swap             | 486 576 kB ≈ 475 MiB            | `/proc/<pid>/status` VmSwap                              | 10:46:00        |
| System swap used         | 501 MiB / 11 GiB                | `free -h`                                                | 10:45:50        |
| System mem used          | 5.0 GiB / 15 GiB (10 GiB avail) | `free -h`                                                | 10:45:50        |

### Disconnect / publish-error rate

| Metric                    | Value | Source                                                                      | Window                      |
| ------------------------- | ----- | --------------------------------------------------------------------------- | --------------------------- |
| `Failed to publish` count | 34    | `journalctl --user -u gits-cockpit.service --since "1 hour ago" \| grep -c` | 09:45-10:45 BST → ~0.57/min |

### Orchestration event rate (60 s window)

Query: `SELECT event_type, COUNT(*) FROM orchestration_events WHERE occurred_at > datetime('now','-60 seconds') GROUP BY 1 ORDER BY 2 DESC;` (read-only). Captured 10:46:39 BST. **Total = 808 events / 60 s ≈ 13.5/s.**

| event_type                           | count (60 s) |
| ------------------------------------ | ------------ |
| thread.activity-appended             | 507          |
| worktree.retiring-started            | 117          |
| thread.message-sent                  | 84           |
| thread.session-set                   | 74           |
| thread.turn-start-requested          | 6            |
| thread.turn-diff-completed           | 6            |
| provider.session.stopped             | 4            |
| thread.user-input-response-requested | 3            |
| thread.meta-updated                  | 3            |
| provider.session.spawned             | 3            |
| thread.created                       | 1            |

Confirms the §T14 expectation: `thread.activity-appended` dominates (507/808 ≈ 63%) and correlates with active-session bursts.

Note: event-loop p99 delay, GC time, and WS-reconnect rate are exported by the s1 harness over OTLP (`t3_*` metrics); scraping the OTLP collector is out of scope for this slice's command set and not captured here.

## Guard result

N/A — no repo change (report-only slice). Only edit is this slice file.

## Merge

Pending orchestrator.

## Verify result (end gate)

—

## Decision (Fable)

—

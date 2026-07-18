# p0-obs-T14-s2 — capture live baseline (pre-change)

Task: T14 · Lane: live (read-only) · Model: opus-4-8/high
Status: pending

## Brief (Fable)

- **Goal:** record the BEFORE numbers from the running `gits-cockpit.service` without deploying anything: RSS ceiling, swap, event-rate SQL, disconnect-error rate. Write them into this file's Hand-back as the baseline the end gate diffs against.
- **Read first:** plan §T14 runtime confirmation queries.
- **Commands:** `systemctl --user show gits-cockpit.service -p MainPID`; `ps -o rss=,vsz= -p <pid>`; `free -h`; `journalctl --user -u gits-cockpit.service --since "1 hour ago" | grep -c 'Failed to publish'`; the §T14 60-second event-count SQL against the live DB (read-only, `sqlite3 file:...?mode=ro`).
- **Invariants:** strictly read-only — no restart, no deploy, no writes to the DB.
- **Acceptance:** baseline table (metric → value → timestamp) in Hand-back.
- **Verification (guard):** N/A (no repo change).

## Hand-back (execution agent)

_(baseline table here)_

## Guard result

—

## Merge

—

## Verify result (end gate)

—

## Decision (Fable)

—

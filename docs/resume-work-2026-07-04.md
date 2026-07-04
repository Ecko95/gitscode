# Resume Work — 2026-07-04

Session-end status for the GITS harness execution + follow-on work. Read this first
next session. Companion: `docs/handoff-2026-07-04.md` (actionable pickup items for an
implementation agent).

## Where things stand

- **Deployed:** `gits-cockpit.service` runs `origin/gits @ 0e3a7318b` (PR #92), healthy on
  `https://subject28.taild6d729.ts.net:8443/gits`. Resource caps active (`MemoryMax=6G`,
  `--max-old-space-size=4096`).
- **CI:** branch protection on `gits` requires the quality job; baseline is green; flake
  ledger deflaked (#85). Known-remaining flakes: `CursorProvider` timeout, browser MSW pair
  (`KeybindingsToast` / `ChatView` locked) — CI-load sensitive, not product bugs.
- **Open PRs on gits:** none. Everything below is merged.

## What shipped this session (~48 PRs to gits)

- **Harness plan (`docs/harness-execution-plan.md`) Waves 0–6 + lanes A–D**, all through the
  required check.
- **Worktree Graveyard** (plan 21): retirement on thread-delete AND inactivity (30-min
  stale-activity guard), orphan adoption (bound = owner-recorded + live thread), age-based
  reaper with a two-layer rebinding guard (live/archived thread refs block pruning).
  `GITS_GRAVEYARD_MAX_AGE_MS` (7d); branches always kept.
- **Event retention + projection rebuild** (plan 22, migration 033): `t3 db archive-events`,
  `t3 db rebuild-projections [--include-archive] [--verify]` (content-fingerprint drift
  detection, fail-loud on decode). Verified live: `rebuild-projections --verify` passed on
  the real DB (1711 events, all 9 projection tables match).
- **Actor identity** (plan 23): server-stamped actor per command, delamain deny-by-default on
  server-mutating commands, thread-scoped tokens cannot approve tool use, `command.denied`
  observable.
- **Audit trail**: every privileged action emits an event (provider spawn/stop, auth
  issue/revoke, settings.changed with key-names-only, standalone vcs worktree RPCs).
- **Reconnect stack**: sequence-gated resync, heartbeat→disconnected, 401→re-pair,
  overflow-terminates-subscription + client resubscribe, turn recovery (socket-kill test).
- **Perf tier 1**: baseline (`docs/perf-baseline-2026-07.md`), bounded provider queues, VCS
  poll coalescing, SQLite pragmas, W1.x drift guards.
- **Security tier 1**: authed `/api/gits/*` routes, non-loopback bind guard, revocable
  visual-plan tokens, provider child-env allowlist, NDJSON secret redaction.
- **Hosting**: portable deploy (WSL/VPS), MemoryMax/heap knobs, `scripts/gits-hosting/profiles/vps.env`,
  `docs/wsl-hosting.md` + `docs/vps-hosting.md`.
- **Git-command confinement shim** (plan 24, #92): POSIX-shell `git` shim under
  `${T3CODE_HOME}/gits-shims/<sessionId>/`, injected into provider-session child PATH only
  (server PATH untouched); supervisor bypasses; **fail-open + WARN on setup failure**
  (verified live: `git-shim.allocate-failed` logs, returns empty vars, does not throw).
  Defense-in-depth, NOT a sandbox — absolute-path/libgit2 bypass documented in plan 24 §3.
- **Interactive Delamain sidepanel** (#91): per-peer View chat (transcript), Kill-with-confirm
  (SIGTERM/SIGKILL), Open PR / Integrate / Copy branch. Deployed.
- **Delamain Codex peer auth** fixed (separate repo `Ecko95/delamain#3`, merged): preflight +
  actionable re-login guidance. Root cause was a 6-week-stale token in the peer's separate
  `~/.delamain/peer-codex-home`; re-login fixed it (verified live with a `PEER_AUTH_OK` round-trip).

## Open decisions for you (operator)

1. **`wsl --shutdown`** still pending to activate the new `/mnt/c/Users/Joshua/.wslconfig`
   (memory=20GB, processors=12, autoMemoryReclaim=gradual, sparseVhd). Takes the session +
   service down briefly; service auto-starts on next login.
2. **OS-level confinement** (bubblewrap/seccomp) — only worth it if the threat model escalates
   to _adversarial_ agents; the shim covers honest-agent accidents. Documented as the future
   tier in plan 24 §5. Decide if/when.
3. **Delamain concurrent-peer auth hazard**: all Codex peers share one `peer-codex-home` and
   ChatGPT refresh tokens are single-use — running 2+ Codex peers at once can re-trigger
   `refresh_token_reused`. Durable fix (not done): API-key mode for the peer home or serialize
   refreshes. See handoff.

## Follow-ups (small, non-blocking — see handoff for details)

- Gate the Delamain **Integrate** button on peer `capabilities` (#91 shows it unconditionally
  for done/completed peers; errors if the server reports integrate unavailable).
- The delamain preflight (#3) covers the `codex exec` peer path only, NOT `gsdRunner.ts` —
  route it through the same check.
- Deferred by design (triggers documented): **W4.3** keyed reactors (engine single-fiber is
  the measured bottleneck; revisit at VPS scale), **W4.7** cold-start snapshots (needs a
  > 500-event on-disk log to measure).

## Your own uncommitted work (not mine — left untouched)

`~/dev/projects/delamain` is on branch `fix/codex-peer-auth-preflight` with your WIP:
`src/gsdRunner.ts`, `src/runner.ts` (`--disable hooks` line), `docs/troubleshooting-peer-hangs.md`,
untracked `docs/incidents/`. To return to `docs/delamain-codex-auth-incident`, commit or stash
first (git refused the auto-switch to protect these — they overlap the merged #3).

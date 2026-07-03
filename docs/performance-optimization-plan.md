# GITS Performance Optimization Plan

> **Superseded as a task source by `docs/harness-execution-plan.md`** — pick tasks only from there (Tier 0 → W0, Tier 1/2 → W1/W4, Tier 3 → W6; the T1.1–T1.3 env gates were cut after measurement). The measurements, baselines, and VPS sizing in this doc remain valid reference.

**Date:** 2026-07-03
**Baseline host:** WSL2 (Windows host ~32GB RAM), 16 cores, 15.5GB visible to WSL, ext4.
**Goal:** run as many parallel agent lanes (worktree + CLI agent + optional dev server) as the host allows, smoothly — first on WSL2, then on a dedicated VPS where GITS should scale to consume all available resources.

Each task below is self-contained so an agent can pick it up independently. Tasks state scope, files, acceptance criteria, and verification. Work branches off `origin/gits`; PRs target `gits` (repo `Ecko95/gitscode`). Wait for the Format/Lint/Typecheck/Test/Build checks before merging. Do not run bare `bun fmt` (it formats the whole repo) — format only touched paths.

---

## Measured baseline (2026-07-03)

Full analysis in the session transcript; key numbers the plan is built on:

| Finding | Measurement |
|---|---|
| Duplicated idle MCP servers across CLI agent sessions | ~30 processes, **~3.2GB RSS** (6 sessions × 5–7 servers each) |
| Claude CLI sessions | 6 × ~450MB |
| Codex `app-server` child per session | ~200–500MB each |
| cursor-agent spawn bursts | ~90% CPU per process |
| Stale `~/.delamain/worktrees` | **86GB**, untouched since early June |
| Project worktrees (`~/dev/projects/gitscode-*`, `t3code*`) | ~20 × ~600MB |
| `.wslconfig` | inert — `[wsl2]` header commented out, defaults apply |
| gits server idle cost | ~360MB, near-zero background CPU (all adapters on-demand) |

Architecture verdict: **no feature removal needed.** Delamain, Hermes, Crit, and visual-plan adapters are all on-demand with zero idle processes. The optimization targets are host configuration, background poll intervals, unbounded growth paths, and resource limits.

---

## Tier 0 — Host/environment (operator tasks, no repo code)

> These are not PRs against this repo. They are recorded here because they dwarf every code change below (~5.5GB RAM + ~95GB disk).

### T0.1 — Scope global MCP servers ⬛ highest single win
- **What:** Remove `splitwise`, `n8n`, `vibe_kanban`, `flights` (and optionally `brave-search`) from the **global** scope in `~/.claude.json` (`mcpServers`) and `~/.codex/config.toml` (`[mcp_servers.*]`). Re-add where needed with project scope (`claude mcp add --scope project` in the relevant directory). Keep `delamain-peers` global.
- **Why:** every Claude and Codex session eagerly spawns a private copy of every global server. N sessions × M servers ≈ 3.2GB idle.
- **Accept:** a fresh `claude` session in a coding repo spawns ≤2 MCP child processes; `ps aux | grep -c splitwise` returns 0 with no finance session open.

### T0.2 — Prune the delamain worktree graveyard
- **What:** `git worktree prune` in each source repo, then remove stale dirs under `~/.delamain/worktrees` (all entries ≥1 month old as of 2026-07-03). Reclaims ~86GB.
- **Accept:** `du -sh ~/.delamain/worktrees` < 5GB.

### T0.3 — Configure WSL2 explicitly
- **What:** in `%UserProfile%\.wslconfig`, uncomment/create the `[wsl2]` section: `memory=20GB`, `processors=14`, `autoMemoryReclaim=gradual`, `sparseVhd=true`. Restart WSL.
- **Accept:** `free -h` inside WSL reflects the configured memory.

### T0.4 — Cache hygiene
- **What:** `npm cache clean --force` (13GB; bun is the package manager). Keep `~/.bun/install/cache` (2.4GB — it powers fast hardlinked installs).

### T0.5 — Skill surface pruning
- **What:** reduce the 77 entries in `~/.claude/skills` to an active profile (`gsd-surface` supports profiles). This is per-session context/token cost multiplied by every concurrent pane.

---

## Tier 1 — Config gates & resource limits (one small PR, low risk)

All gates live in the server layer composition; no request-handler changes. Default every flag to current behavior (on) so this is a pure opt-out addition.

### T1.1 — Env-gate ProcessResourceMonitor
- **Files:** `apps/server/src/ProcessResourceMonitor.ts` (5s tick spawning `ps`, interval at ~line 22), layer wired in `apps/server/src/server.ts` (~line 394).
- **What:** skip the layer (or return a no-op) when `GITS_ENABLE_PROCESS_MONITORING=0`.
- **Accept:** with flag=0, no periodic `ps` children; server boots and serves normally. Unit test: layer resolves to no-op under the env var.

### T1.2 — Env-gate ProviderSessionReaper
- **Files:** `apps/server/src/provider/Layers/ProviderSessionReaper.ts` (5-min sweep, `DEFAULT_SWEEP_INTERVAL_MS`/`DEFAULT_INACTIVITY_THRESHOLD_MS` at lines 16–17), startup fork in `apps/server/src/serverRuntimeStartup.ts` (~line 335).
- **What:** `GITS_ENABLE_SESSION_REAPER=0` disables; also read sweep interval + inactivity threshold from env (`GITS_SESSION_REAPER_SWEEP_MS`, `GITS_SESSION_INACTIVITY_MS`).
- **Accept:** flag honored; intervals overridable; defaults unchanged.

### T1.3 — Env-gate Hermes layer
- **Files:** `apps/server/src/gits/Layers/HermesCliAdapter.ts`, wiring in `apps/server/src/server.ts` (~lines 67–68).
- **What:** `GITS_HERMES_ENABLED=0` swaps in a stub adapter whose endpoints return a clear "hermes disabled" error. Core orchestration must be unaffected (adapter is already on-demand; this is for hosts without the hermes binary).
- **Accept:** with flag=0, `/api/gits/hermes/*` returns a typed disabled error; everything else works.

### T1.4 — Hosted-profile defaults for poll intervals
- **Files:** `apps/server/src/gits/Layers/AutomodeDriver.ts` (tick, lines 17–21, already env-tunable via `GITS_AUTOMODE_DRIVER_TICK_MS`), `apps/server/src/vcs/GitVcsDriverCore.ts:51-55` (`STATUS_UPSTREAM_REFRESH_INTERVAL` = 15s), `packages/contracts/src/settings.ts:455` (`DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL` = 30s), deploy script env in `scripts/gits-hosting/deploy-gits-tailnet-hosted.sh`.
- **What:** make the 15s upstream-refresh interval env-tunable (`GITS_VCS_UPSTREAM_REFRESH_MS`); set hosted-deploy defaults: automode tick 15000, upstream refresh 60000, auto-fetch 120s.
- **Accept:** intervals read from env; deploy script exports the hosted defaults into the systemd unit.

### T1.5 — Memory limits on the hosted service
- **Files:** `scripts/gits-hosting/install-wsl-user-service.sh` (unit template, ~lines 67–86).
- **What:** add `MemoryMax=` (default 4G, overridable) to the unit and `--max-old-space-size=3072` to the node invocation; both parameterized by env vars in the deploy script.
- **Accept:** installed unit contains both limits; service starts and serves.

---

## Tier 2 — Code changes (independent PRs, ordered by value)

### T2.1 — Worktree reaper ⬛ prevents the 86GB failure mode inside gits
- **Files:** worktree create/remove in `apps/server/src/vcs/GitVcsDriverCore.ts:2059-2164` (`createWorktree`/`removeWorktree`, `worktreesDir` from `apps/server/src/config.ts:78-108`); pattern to copy: `ProviderSessionReaper.ts`.
- **What:** background sweep (default every 6h, env `GITS_WORKTREE_REAPER_SWEEP_MS`) that removes server-created worktrees under `worktreesDir` not referenced by any live thread/session and older than `GITS_WORKTREE_MAX_AGE_MS` (default 7 days). Must never touch worktrees outside `worktreesDir`. Log every removal.
- **Accept:** unit test — stale unreferenced worktree removed, referenced/young worktree kept; sweep disabled via env flag.

### T2.2 — Bound provider event queues
- **Files:** `Queue.unbounded()` in `apps/server/src/provider/Layers/CodexSessionRuntime.ts` (~line 454), `CodexAdapter.ts`, `OpenCodeAdapter.ts`.
- **What:** replace with `Queue.bounded(10_000)` (or `Queue.dropping`/`sliding` where loss is tolerable) + explicit overflow handling that fails the session with a typed error instead of OOMing the server.
- **Accept:** typecheck/tests green; a saturation test enqueueing >capacity surfaces the typed error, not unbounded growth.

### T2.3 — Coalesce VCS polling per repo (not per worktree)
- **Files:** `apps/server/src/vcs/VcsStatusBroadcaster.ts` (per-cwd pollers, ~lines 26–110, 216–300), `GitVcsDriverCore.ts` upstream-refresh cache (keyed by `gitCommonDir` + remote, lines 51–55).
- **What:** worktrees of the same repo share a `gitCommonDir`; run one remote fetch/refresh loop per (`gitCommonDir`, remote) and fan results out to all subscribed worktree streams. Local `git status` stays per-worktree.
- **Why:** this is the dominant O(worktrees) background cost — at 20 worktrees the current design runs 20 fetch loops for what is ~4 repos.
- **Accept:** with N worktrees of one repo subscribed, exactly 1 fetch loop runs (assert via spawn-count in test); all N streams still receive updates.

### T2.4 — OrchestrationEvents retention
- **Files:** `apps/server/src/persistence/` (event append in `OrchestrationEngine.ts` ~line 176; migrations dir — next number after 032).
- **What:** archival policy for `OrchestrationEvents`: periodic job (reuse reaper scheduling pattern) that deletes or archives events older than `GITS_EVENT_RETENTION_DAYS` (default 90) for closed threads, then `PRAGMA optimize`. Keep receipts needed for idempotency.
- **Accept:** migration + job land; test proves old closed-thread events pruned, open-thread events retained.

### T2.5 — Fast dependency install on worktree create (verify, then wire)
- **Files:** worktree creation path (T2.1 files); `scripts/gits-hosting/deploy-gits-tailnet-hosted.sh:90-96` as reference.
- **What:** confirm bun's hardlink backend is used on ext4 (`bun install --backend hardlink` from `~/.bun/install/cache`), then offer an opt-in "install deps on worktree create" step so agent lanes start ready. Skip entirely on `/mnt/c` paths.
- **Accept:** documented benchmark in the PR: worktree add + install < 15s (target from `docs/linux-remote-dev-performance.md`).

---

## Tier 3 — VPS migration (after Tiers 1–2)

### T3.1 — Sizing & provisioning
Budget **~1GB RAM per parallel agent lane** (CLI session ~450MB + codex app-server ~300MB + trimmed MCP ~150MB) + ~600MB disk per worktree; flat ~600MB for gits server + SQLite + hermes daemon. A 32GB/8-core VPS ≈ 20 lanes; 64GB if per-lane vite dev servers (~300–500MB each) are common. NVMe + native ext4 (never a mounted Windows FS).

### T3.2 — Deploy script portability
Generalize `scripts/gits-hosting/deploy-gits-tailnet-hosted.sh` + `install-wsl-user-service.sh` beyond WSL: skip the Windows portproxy step when not under WSL (`WSL_DISTRO_NAME` unset), use `tailscale serve` directly on the VPS. `docs/backlog/headless-remote-agent-registry.md` confirms the single-instance `t3 serve --host $(tailscale ip -4)` model is the intended path — no registry needed.

### T3.3 — Scale-up knobs on the VPS
Invert the Tier 1 hosted profile: shorter poll intervals, higher `MemoryMax`, automode tick back to 5s, session reaper thresholds relaxed. All knobs already exist after Tier 1 — this is a config profile, not code.

---

## Suggested execution order

| Order | Task | Type | Effort | Expected win |
|---|---|---|---|---|
| 1 | T0.1–T0.5 | operator | 1h | ~5.5GB RAM, ~95GB disk, faster session spawn |
| 2 | T1.1–T1.5 | 1 PR | S | idle CPU ↓, OOM protection on hosted service |
| 3 | T2.1 | PR | M | unbounded disk growth eliminated |
| 4 | T2.3 | PR | M | background git load O(repos) instead of O(worktrees) |
| 5 | T2.2 | PR | S | OOM risk closed |
| 6 | T2.4 | PR | S | DB growth bounded |
| 7 | T2.5 | PR | S | instant-ready agent lanes |
| 8 | T3.1–T3.3 | ops + 1 PR | M | VPS migration |

# Continuation — written 2026-07-13 evening (after Tiers 1–2 + design pivot)

Companions: `2026-07-13-followups.md` (Tiers 1–2 DONE), `2026-07-13-report.md`. Memory: `autonomy-followups-2026-07-13`.

## State snapshot (all verified 2026-07-13)

- **Merged today** — gitscode: #145 (off-hours design of record), #147 (addendum decisions 18–24), #148 (`docs/gits/VPS_SETUP.md` runbook). delamain: #14 (dep-aware sweep), #15 (clear-integration-fields-on-resume), #16 (pricing: gpt-5.3-codex family + gpt-5.6-terra), #17 (hygiene: MCP `depends_on`/`claims` on BOTH spawn tools, cost-walk guards, dashboard terminal-set dedup). Final delamain main: 105 unit + 193 integration green.
- **Installed delamain binary + delamain-peers MCP config now track `~/dev/projects/delamain-main`** (detached at origin/main). Rebuild flow: `git fetch && git checkout --detach origin/main && npm ci && npm run build`. The `~/dev/projects/delamain` checkout stays on `a2a-state-race-lock` (in-flight; local `main` there holds unpushed bb5a362) — do NOT touch it.
- **Pi spike CANCELLED** (decision 18). Never open a PR for `spike/pi-continuous-brain`; branch is read-only baseline data. Motoko/Hermes on the codex provider is the sole brain; autonomy is all-codex (decision 19 — headless Claude is metered).
- **Motoko has never run**: cockpit error "Codex auth is missing access_token". Source: `apps/server/src/gits/Layers/HermesCliAdapter.ts` — codexHome resolution ~line 332, `hermesAuthPath = hermesHome/auth.json` ~line 519 (snapshot suspected; re-read + refresh missing).
- `~/.delamain/monitor.sh` retired (cron line removed; archive at `monitor.sh.retired-20260713`; crontab backup in `~/.delamain/`).

## Next steps (ordered)

1. **Provision the VPS** per `docs/gits/VPS_SETUP.md` (netcup **RS 2000 G12** — delivered 2026-07-13, Ubuntu 24.04.4 installed, root key-auth working via the operator machine's `vps-eu` ssh alias; RS 4000 was the intent, RS 2000 kept deliberately — upgrade-anytime path exists). Remaining human-in-loop steps to request as they arrive: tailnet node approval + key-expiry disable, on-host codex OAuth logins (one per consumer home — never copy auth.json between hosts). Agent steps: hardening, ufw/tailscale, runtime stack, repo clones ×3, verify floor green, GITS deploy via `scripts/gits-hosting/deploy-gits-tailnet-hosted.sh`. Exit: both SSH paths work; verify floor green on gitscode, delamain, isomer-calc-engine.
2. **Hermes codex auth lifecycle** (decision 21): dedicated codex home for Hermes; adapter re-reads auth at spawn time (no startup snapshot); auto-refresh expired access tokens (delegate to codex app-server if it already owns refresh for that home — read `HermesCliAdapter.ts` fully before deciding). Non-peer code change ⇒ fable subagents with spec-review + quality-review loop.
3. **Decision-19 audit**: find every headless Claude-provider instantiation in automode/verifier/Hermes paths; pin to codex or disable.
4. **Exit test**: one full Motoko proposal cycle end-to-end (proposal card → decideProposal → HermesAutomodeBridge → automode) — this is the phase-0 exit criterion and Motoko's first-ever production run.
5. Then **phase 1** (slot scheduler + arming): episode ID (decision 23) in the schema from day one; steal anything-llm's shape (memory: `orchestration-sweep-2026-07`).

## Deferred / waiting

- After `a2a-state-race-lock` merges: `withStateLock` upgrades (sweep, claims pre-flight, mergeState refresh) — followups item 7.
- Sweep the four live-test peers when aged — `delamain sweep --dry-run` first, always.
- Low review debt: claims lack repo scoping over MCP; ambiguous `depends_on` prefixes bind to newest peer silently; gpt-5.6-sol/luna price at DEFAULT.
- Phase 6 review surface + Motoko-tab console (decisions 22–23) after phases 1–2.

## Discipline (unchanged)

Fable subagents with spec+quality review for non-peer code. Peer-sized delamain work → delamain peers (gpt-5.5/high, `--claims`, verify turn_context on first spawn). `delamain sweep` only ever `--dry-run` first. gh always `--repo Ecko95/gitscode` (default-repo gotcha). Branch off `origin/gits`, PR base `gits`; wait for CI (Format needs oxfmt; wsTransport resubscribe test is a known flake — rerun once before digging).

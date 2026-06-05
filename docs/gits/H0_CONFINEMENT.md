# H0 — Execution Confinement (implementation + integration)

Date: 2026-06-05
Branch: `feat/gits-h0-confinement-spike`
Implements §Hardening **H0** of `ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` — the red-team's foundational prerequisite: peers **and** verification must run under OS-level confinement or the whole self-improvement trust model is void.

## Status

| Step | State | Where |
|---|---|---|
| Feasibility (bubblewrap viable) | ✅ done | `spikes/h0-confinement/` (10/10 → now 14/14) |
| Canonical, profiled wrapper | ✅ done | `scripts/gits-confine.sh` (`verify`/`peer` profiles) |
| **Verification-under-confinement** (RCE-closer) | ✅ done (artifact ready) | `scripts/confined-verify.sh` |
| Peer **minimal-credential** binding | ✅ done | `gits-confine.sh --profile peer --cred …` |
| Peer **egress allowlist** | ⛔ blocked on host | needs `passt`/`pasta` or root nftables (absent here) |
| **Wire into autopilot `supervisor.py`** | ✅ applied (backward-compatible) | external skill (`run_gate`/`confine_script`); validated end-to-end |
| **GITS-side gate** (typed adapter) | ✅ added + server-wired + tested | `GitsVerificationGate` + `GitsConfinedVerifyAdapter` (4/4 tests) |
| Wire into delamain peer spawn | ◻ pending (needs delamain support) | external binary |

All harness checks pass: `./spikes/h0-confinement/run-spike.sh` → **14/14**, deterministic, self-cleaning. The GITS gate adapter passes `4/4` unit tests; its contracts typecheck clean.

## Artifacts

- **`scripts/gits-confine.sh`** — runs a command under bubblewrap.
  - `--profile verify` (default): worktree-only writes, **no credentials**, **network off**, **npm lifecycle scripts disabled**. For untrusted-repo verification.
  - `--profile peer`: binds **only** the named `--cred <abs-path>` read-only (everything else in `$HOME` stays invisible); `--egress off|host|proxy=<addr>`; lifecycle scripts allowed (contained by the sandbox).
- **`scripts/confined-verify.sh`** — runs a **server-pinned** verification suite (explicit argv arrays, never the repo's `npm run <label>` indirection) against a worktree under the verify profile; structured pass/fail; exit = failure count.

## Integration 1 — verification-under-confinement (✅ APPLIED)

> **Status:** applied to the live autopilot and validated end-to-end (a hostile `cat <secret>`
> verification command runs confined → rc≠0, **no leak**; benign commands still pass).

### 1a — autopilot `supervisor.py` (applied, backward-compatible)

`auto_review_and_merge`'s per-command `run(cmd, cwd=wt)` (the RCE surface — it executed the repo's
own scripts on the host with operator secrets on `PATH`/`HOME`) now calls a new `run_gate(cmd, wt,
config, …)` that wraps each command through `scripts/gits-confine.sh --profile verify` when a
`confine_script` is locatable **and** `bwrap` is present, and **falls back to the legacy `run`
otherwise** so running chains never break. Helpers added: `confine_script(config)` (resolves the
wrapper via `config.confine_script` / `config.gitscode_path` / `GITS_CONFINE_SCRIPT` /
`GITSCODE_PATH`, gated on `confine_verification` default-true + `bwrap` present) and
`run_gate(...)`. The supervisor logs `verification gate mode: confined|DIRECT` each review.
The original file is backed up at `supervisor.py.bak-h0-*`. (The autopilot is a skill, external to
this repo; the edit is recorded here.)

**Activate per chain** by adding to that chain's `config.json`:
```json
{ "confine_verification": true, "gitscode_path": "/abs/path/to/a/gitscode/checkout-with-scripts" }
```
(or set `GITS_CONFINE_SCRIPT=/abs/.../scripts/gits-confine.sh`). Without it, the chain keeps the
legacy behavior — no surprise breakage. **Caveat:** point `gitscode_path` at a checkout/branch that
actually contains `scripts/gits-confine.sh` (this branch), or install the script to a fixed path.

### Reference: the equivalent server-pinned call (CLI form)

The autopilot could also shell the convenience runner directly:

```python
# supervisor.py — instead of run(["npm","run",label], cwd=wt) per verification command:
import json, subprocess
suite = [
    {"label": "lint",  "cmd": ["npx", "eslint", "."]},
    {"label": "tsc",   "cmd": ["npx", "tsc", "--noEmit"]},
    {"label": "test",  "cmd": ["npx", "vitest", "run"]},
    {"label": "build", "cmd": ["npm", "run", "build"], "timeoutSeconds": 900},
]
rc = subprocess.call([
    "<repo>/scripts/confined-verify.sh", "--worktree", wt,
    "--commands-json", json.dumps(suite),
]).
# rc == 0 → gate green; rc > 0 → that many commands failed → halt as before.
```

Notes:
- Prefer **direct tool argv** (`npx eslint .`, `npx tsc --noEmit`, `npx vitest run`) over `npm run <label>` for untrusted repos, so the repo can't redefine the gate via its scripts (server-pinned).
- This is **net-off, secret-free**, so it is safe today with no further host changes.

### 1b — GITS-side gate: typed `GitsVerificationGate` adapter (✅ added + server-wired + tested)

GITS had no command-executing verification gate (the planning scanner only *reads* `.planning`
evidence). Added one, mirroring the existing CLI adapters:
- **Contracts** (`packages/contracts/src/gits.ts`): `GitsVerifyCommand` (label + **server-pinned argv** + optional timeout), `GitsVerifyInput` (worktree, commands, `requireConfinement` default true), `GitsVerifyCommandResult`, `GitsVerifyResult` (worktree, `confined`, `passed`, results, checkedAt), `GitsVerificationGateError`.
- **Service** `apps/server/src/gits/Services/GitsVerificationGate.ts`.
- **Layer** `apps/server/src/gits/Layers/GitsConfinedVerifyAdapter.ts`: probes `bwrap`; **fails closed** (`GitsVerificationGateError`) when confinement is unavailable and `requireConfinement` is set; otherwise runs each command through `gits-confine.sh --profile verify` (resolved via `GITS_CONFINE_BIN`) via the shared `ProcessRunner`, aggregating structured per-command results.
- **Wired** into `server.ts` `GitsLayerLive` (`GitsConfinedVerifyAdapterLive`).
- **Tests** `GitsConfinedVerifyAdapter.test.ts` (4/4): confined aggregation, failing-command reporting, fail-closed when `bwrap` absent, unconfined only when `requireConfinement:false`.

This is the gate the future canary / `OrchestratorConfigExecutor` (design §D) consumes. Operators set
`GITS_CONFINE_BIN` to an absolute `scripts/gits-confine.sh` (or put it on `PATH`). RPC exposure +
canary consumption are the follow-up; the capability is constructed and tested now.

> The live `supervisor.py` is a shared skill that drives the operator's running autopilot chains;
> this guide gives the exact patch but does **not** edit it automatically — apply it when ready.

## Integration 2 — peer-under-confinement

The peer (codex/cursor) is launched by the external `delamain` binary (`DelamainCliAdapter.spawnArgs`
builds `delamain spawn …`). Two ways to confine it:
1. delamain launches its codex/cursor child through `gits-confine.sh --profile peer …` (needs delamain support), or
2. GITS spawns peers under confinement directly.

Peer profile call shape (minimal creds; egress off until an allowlist exists):

```bash
scripts/gits-confine.sh --worktree "$WT" --profile peer \
  --cred "$HOME/.delamain/peer-codex-home/auth.json" \
  --cred "$HOME/.delamain/peer-codex-home/config.toml" \
  --egress off \
  -- codex exec --json "…"
```

This already guarantees (verified by P1/P2): the peer sees **only** the provider credential, never
`~/.codex/auth.json`, `~/.gits/hermes`, `~/.gits/secrets`, telegram creds, or the cursor-dashboard token.

Also drop the privilege-bypass flags for untrusted repos: no codex `--yolo`/`danger-full-access`,
no cursor `--force --trust`.

### Egress allowlist (the remaining gap)

A peer needs network to reach the model API — but should reach **only** the model API + the
authenticated memory proxy (H3), nothing else. A true allowlist for an unprivileged user-namespace
sandbox needs one of:
- **`passt`/`pasta`** (userspace TAP) + a CONNECT proxy enforcing the host allowlist; peer uses
  `--egress proxy=<addr>`. *Recommended once `passt` is installed (`apt install passt`).*
- **root netns + nftables** egress filter.

Neither `passt`/`pasta`/`slirp4netns` is present on this host, so `--egress proxy=` is currently
**advisory only** (the wrapper sets `HTTPS_PROXY` but cannot prevent a hostile peer from bypassing it
over shared host net). Therefore, until userspace-net lands:
- run **verification** confined + net-off (safe now), and
- run **peers** only on trusted repos, or accept unfiltered peer egress as a known residual risk.

## Prerequisites & portability

- `bwrap` (bubblewrap) + unprivileged user namespaces (present here; WSL2 kernel 6.6).
- Hosts that disable unprivileged userns (`kernel.apparmor_restrict_unprivileged_userns=1`) need a
  setuid `bwrap` or rootless podman/nsjail. Detect and fail closed.
- `jq` for `confined-verify.sh`.

## Recommended next implementation slices

1. **Wire `confined-verify.sh` into the autopilot + GITS gate** (closes the RCE; net-off, no host changes). Highest value.
2. **Confine peer spawn with `--profile peer` + minimal creds** (cred-minimization works today; drop bypass flags).
3. **Install `passt` and enable the egress allowlist** (`--egress proxy=`), turning peer net into model-API-+-memory-proxy-only.

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
| Wire into autopilot `supervisor.py` | ◻ pending (snippet below; live-skill edit deferred) | external skill |
| Wire into delamain peer spawn | ◻ pending (needs delamain support) | external binary |

All harness checks pass: `./spikes/h0-confinement/run-spike.sh` → **14/14**, deterministic, self-cleaning.

## Artifacts

- **`scripts/gits-confine.sh`** — runs a command under bubblewrap.
  - `--profile verify` (default): worktree-only writes, **no credentials**, **network off**, **npm lifecycle scripts disabled**. For untrusted-repo verification.
  - `--profile peer`: binds **only** the named `--cred <abs-path>` read-only (everything else in `$HOME` stays invisible); `--egress off|host|proxy=<addr>`; lifecycle scripts allowed (contained by the sandbox).
- **`scripts/confined-verify.sh`** — runs a **server-pinned** verification suite (explicit argv arrays, never the repo's `npm run <label>` indirection) against a worktree under the verify profile; structured pass/fail; exit = failure count.

## Integration 1 — verification-under-confinement (do this first; closes the RCE)

Today the autopilot runs the repo's verification commands directly on the host
(`run(cmd, cwd=wt)` in `delamain-autopilot/scripts/supervisor.py`), and the auto-review policy
shells `npm run lint/test/build` resolved against the **repo's own** `package.json` — i.e. a hostile
repo's scripts execute on the host with the operator's secrets on `PATH`/`HOME`. Replace that with a
confined, server-pinned call:

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
- The GITS-side gate (when GITS runs verification itself) calls the same script.
- This is **net-off, secret-free**, so it is safe today with no further host changes.

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

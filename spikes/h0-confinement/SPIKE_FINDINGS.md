# H0 Confinement Spike — Findings

Date: 2026-06-04
Branch: `feat/gits-h0-confinement-spike`
Relates to: `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` §Hardening **H0** (the red-team's foundational finding: the self-improvement trust model is void unless peers **and** verification run under OS-level confinement).

## Question

Can we run a coding peer's command **and** its verification suite on this host under OS-level confinement such that a hostile repo cannot (a) read operator secrets, (b) write outside its worktree, (c) execute install-time scripts, or (d) reach the network — while legitimate work + verification inside the worktree still succeed?

## Verdict: **VIABLE** on this host (10/10 checks pass, deterministic, no residue).

Mechanism: **bubblewrap (`bwrap` 0.9.0)** — unprivileged, user-namespace based, no daemon, no root. Chosen because Docker/podman/firejail/nsjail are absent but `bwrap` + unprivileged user namespaces are present and working.

## Host primitives detected

| Primitive | State |
|---|---|
| `bwrap` (bubblewrap) | ✅ /usr/bin/bwrap 0.9.0 |
| unprivileged user namespaces | ✅ `max_user_namespaces=63769`, no apparmor userns restriction; `unshare --user --map-root-user` works |
| landlock (kernel) | ✅ present (68 symbols) — available for future tightening |
| docker / podman / firejail / nsjail | ❌ absent |
| kernel | 6.6.87 microsoft-standard-WSL2 |
| toolchain | node v24.12.0 + npm 11.6.2 (under `~/.nvm`), pnpm, bun 1.3.13 |

## Results (`./run-spike.sh`)

An **unconfined control** runs first and confirms the attack is real (the probe reads the planted sentinel secret). Then, confined via `gits-confine.sh`:

| Check | Result | Proof |
|---|---|---|
| A. real-`$HOME` secret invisible | ✅ | `SENTINEL_READ=NO` — planted `~/.gits-h0-spike-sentinel-SECRET.txt` unreadable |
| C. write to read-only system mount blocked | ✅ | `/etc` write denied |
| C2. no host escape | ✅ | no `PWNED` file in real `$HOME` after run |
| D / D2. write inside worktree allowed + visible on host | ✅ | worktree is the one writable, host-persistent path |
| E. network off (egress blocked) | ✅ | `fetch()` fails under `--unshare-net` |
| F. npm lifecycle script did NOT run | ✅ | malicious `preinstall` skipped (`--ignore-scripts` forced) |
| G. executed script contained | ✅ | running the malicious script directly: it runs but cannot escape |
| H. benign verification runs confined | ✅ | `node verify.js` exits 0 inside the sandbox |

## What `gits-confine.sh` enforces

- **Writable set = the worktree only.** `--bind <worktree>` is the sole writable real path; everything else is `--ro-bind` (system) or `--tmpfs` (ephemeral `/tmp`, `/run`, `HOME=/sandbox-home`).
- **Secrets excluded.** `$HOME` is a fresh tmpfs, so `~/.codex/auth.json`, `~/.gits/secrets`, `telegram.env`, cursor-dashboard token, etc. are simply not present. `--clearenv` then a minimal `PATH/HOME/TERM/LANG` drops secret-bearing env vars too.
- **Install-time RCE neutralized.** `NPM_CONFIG_IGNORE_SCRIPTS=true` forces `--ignore-scripts`; even if a script runs, it is contained.
- **Network off by default.** `--unshare-net` (no loopback either); `--net` opt-in for the install case (see caveat).
- **Namespaces + caps.** user/pid/ipc/uts/cgroup unshared, `--cap-drop ALL`, `--new-session` (no TIOCSTI injection), `--die-with-parent`.

## Key findings (these shape the real integration)

1. **The toolchain lives inside `$HOME` (nvm) — it must be bound read-only explicitly.** Naively excluding `$HOME` also hides `node`/`npm`. The wrapper binds *only* the node install root (`~/.nvm/versions/node/vX`) read-only, so the toolchain works while the rest of `$HOME` (the secrets) stays invisible. Same pattern needed for pnpm/bun if used (`GITS_CONFINE_EXTRA_ROBINDS`).
2. **Peers need what verification does not — this splits H0 into two regimes.**
   - **Verification** (lint/tsc/test/build, the autopilot RCE surface) needs **no provider creds and no network** → can run fully confined, net-off, secret-free. *This is the high-value, low-friction first integration and closes the RCE the red-team flagged.*
   - **Peer execution** (codex/cursor) genuinely needs (a) a provider credential to call the model API and (b) network to reach it. Full secret-exclusion/net-off is therefore impossible for the peer process. Resolution direction: bind **only** the minimal provider credential read-only (e.g. `~/.delamain/peer-codex-home/auth.json`) and nothing else, and replace shared host networking with an **egress allowlist** (model API + the authenticated memory proxy from H3 only). This is more work and is the second step.
3. **Ephemeral-root nuance (documented, not a hole).** Writes to *unbound* absolute paths (e.g. a real-home sibling) land on bwrap's ephemeral root tmpfs and vanish on exit — they never reach the host (verified by C2). The only host-persistent writable path is the worktree.
4. **Network "on" currently shares host net — a known limitation.** With `--net`, the sandbox can also reach `localhost` services (the Basic Memory MCP, the GITS server). Production needs a userspace network (pasta/slirp4netns) or an egress-filtering proxy, not the host net namespace. For untrusted-repo verification, keep net **off** and pre-fetch dependencies in a separate trusted step.
5. **Portability caveat.** This host allows unprivileged user namespaces. Hardened distros that set `kernel.apparmor_restrict_unprivileged_userns=1` or disable userns require a setuid `bwrap` or an alternative (rootless podman / nsjail). Detect and fail closed.

## How this maps to GITS (integration path, not done in the spike)

- **First (closes the RCE):** wrap the **autopilot verification commands** (`run(cmd, cwd=wt)` in `delamain-autopilot/scripts/supervisor.py`, and the GITS-side gate) in `gits-confine.sh` — net-off, secret-free, `--ignore-scripts`, server-pinned argv (not repo `package.json` scripts). Lowest friction, highest security payoff.
- **Second (confines the peer):** the peer process is spawned by the external `delamain` binary (`DelamainCliAdapter.spawnArgs` builds `delamain spawn …`). Applying H0 to the peer requires either delamain launching its codex/cursor child through a confinement wrapper, or GITS spawning peers under confinement directly. Needs: minimal-cred bind + egress allowlist + drop `--yolo`/`danger-full-access`/`--force --trust` for untrusted repos.
- **Memory (ties to H3):** with the peer confined and net-allowlisted, the GITS-mediated memory proxy is the *only* reachable write surface — exactly the H3 trust boundary.

## Effort / friction

- Verification-under-confinement: **small** — wrap existing command execution; the wrapper is ~80 lines and works today.
- Peer-under-confinement: **medium** — needs the cred-minimization + egress-allowlist work and possibly delamain changes.

## Limitations / not done

- No egress-allowlist / userspace-net yet (net is all-or-nothing).
- Not wired into delamain or the autopilot (spike only).
- No seccomp profile or landlock policy yet (bwrap caps/namespaces only); landlock is available to tighten the read set further.
- Single host (WSL2); CI/other hosts need the portability check.

## Recommendation

Adopt bwrap-based confinement. Ship **verification-under-confinement first** (it closes the red-team's RCE finding with minimal friction and unblocks the rest of H0), then peer-execution confinement with minimal-cred binding + an egress allowlist. Gate any loop-auto-apply (Phase 3) on both being in place, per the design's H0 prerequisite.

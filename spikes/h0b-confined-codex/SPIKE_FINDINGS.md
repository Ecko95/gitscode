# H0b Spike — Confined `codex exec` recipe

Date: 2026-06-08 · Host: WSL2 (kernel 6.6), `bwrap` present, `passt`/`pasta` absent.

## Goal
Find the exact `gits-confine.sh --profile peer … -- codex exec …` invocation that runs a codex peer **jailed to the worktree** (sandcastle model, `autonomous-toggle.md` Q7/Q8) — authenticates + completes a trivial task.

## Result: SOLVED end-to-end (infra) — binary + credentials + **DNS** all work; only remaining issue is a stale peer token (operator `codex login`)

> **UPDATE (2026-06-08):** the egress/DNS blocker below is **FIXED** in `gits-confine.sh` (bind the resolv.conf symlink target when the peer has network — see "DNS fix" section). A confined codex now resolves `auth.openai.com`/`chatgpt.com` and reaches the API; the final run returned **HTTP 401 "refresh token already used"** — a stale credential, NOT a jail defect (re-login the peer home). The recipe below is fully validated to the live-API boundary.

| Recipe | Outcome |
|---|---|
| A — `CODEX_HOME` → bound cred dir, creds via `--cred` | ❌ `bwrap: execvp codex: No such file or directory` — codex not on the jail's fixed PATH |
| B — `--ro $PEER_HOME` + `CODEX_HOME` | ❌ same (binary not found) |
| C — `--ro <nvm-node-dir>`, rely on script's auto NODE_BIN | ❌ script auto-detects a **different** node (v25.5.0) than codex's (v24.12.0); v24 bin never lands on PATH |
| **D** — `--ro <nvm24>` + `--setenv PATH=<nvm24/bin>:…` (codex's own node+codex on PATH) + `--setenv CODEX_HOME` + creds | ⚠️ **codex launches + reaches auth**, then fails: `failed to lookup address information: Try again` / `Failed to refresh token: …auth.openai.com` — **DNS/network does not work inside the jail** |

### The binary+cred recipe that WORKS (Recipe D, validated to the auth stage)
```bash
NVM24=/home/joshua/.nvm/versions/node/v24.12.0   # codex's own node toolchain
gits-confine.sh \
  --worktree "$WT" --profile peer --egress host \
  --ro "$NVM24" \
  --cred "$PEER_HOME/auth.json" --cred "$PEER_HOME/config.toml" \
  --setenv "CODEX_HOME=$PEER_HOME" \
  --setenv "PATH=$NVM24/bin:/usr/local/bin:/usr/bin:/bin" \
  -- codex exec --json -C "$WT" -
```
- **Why the `--ro` + `PATH` override:** `codex` = `~/.local/bin/codex` → `~/.nvm/versions/node/v24.12.0/bin/codex` (a node script). The jail uses a fixed PATH and auto-detects whatever `node` is first in the *caller's* PATH (here v25.5.0), so codex's bin dir must be explicitly bound (`--ro`) and put on PATH (`--setenv PATH`). codex.js's `#!/usr/bin/env node` then resolves to the same v24 node.
- **Confirmed reachable inside the jail:** `node`, `codex`, and the bound `CODEX_HOME` creds — codex got far enough to attempt an OAuth token refresh, so auth wiring is correct.

## The DNS fix (SOLVED)
Root cause: host `/etc/resolv.conf` is a **symlink** → `/mnt/wsl/resolv.conf` (WSL2; or `/run/systemd/resolve/stub-resolv.conf` under systemd). The peer profile binds `/etc` read-only (so the symlink appears) but **not its target**, and `--tmpfs /run` would also hide a systemd target — leaving a **dangling link** inside the jail → `cat /etc/resolv.conf: No such file or directory` → `EAI_AGAIN`.

Fix (in `scripts/gits-confine.sh`, gated on `EGRESS != off`): resolve the host link and **bind its target at its own path** so the link resolves inside the jail:
```bash
resolv_target="$(readlink -f /etc/resolv.conf)"        # /mnt/wsl/resolv.conf (or systemd stub)
[ -f "$resolv_target" ] && bwrap … --ro-bind "$resolv_target" "$resolv_target" …
```
Placed after `--tmpfs /run` so it also covers the systemd `/run/...` layout. Verified: `getent hosts api.openai.com` resolves inside an `--egress host` peer; `--egress off` stays net-isolated (regression test: `dns.test.sh`). Note `--egress host` is still **not an allowlist** (a hostile peer could reach any host) — fine for a TRUSTED repo per Q7; the real allowlist is H0c (`passt`).

## Bottom line
- **Solved (infra, validated to the live-API boundary):** binary/toolchain (Recipe D) + credentials + **DNS/egress**. A confined codex peer launches jailed, reads its bound creds, and reaches the OpenAI API.
- **Remaining for a green e2e:** a **fresh** peer login (`codex login` into `~/.delamain/peer-codex-home`) — the spike's token was stale (HTTP 401 "refresh token already used"). Operator action, not a jail defect.
- delamain **Task 5** (wrap `codex` in this invocation) can now be implemented AND validated (Plan 2 Task 7 e2e) once the peer is re-logged-in.

# H0b Spike — Confined `codex exec` recipe

Date: 2026-06-08 · Host: WSL2 (kernel 6.6), `bwrap` present, `passt`/`pasta` absent.

## Goal
Find the exact `gits-confine.sh --profile peer … -- codex exec …` invocation that runs a codex peer **jailed to the worktree** (sandcastle model, `autonomous-toggle.md` Q7/Q8) — authenticates + completes a trivial task.

## Result: PARTIAL — binary + credentials SOLVED; **egress/DNS is a blocker**

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

## The blocker: DNS inside the jail
`--egress host` shares the host network namespace (no `--unshare-net`), but codex still cannot resolve `auth.openai.com` / `chatgpt.com` (`EAI_AGAIN`). Most likely cause: the jail's `--tmpfs /run` (and `--clearenv`) hides the host's **systemd-resolved** stub / resolver state that WSL2 DNS depends on. This is the **egress/networking** problem the H0 design defers to **H0c** — it surfaced here because a real codex peer *needs* working egress, unlike the net-off verification gate.

### Likely fixes (a follow-up, NOT solved here)
- Bind the resolver into the jail: e.g. `--ro-bind /run/systemd/resolve /run/systemd/resolve` (or bind `/etc/resolv.conf`'s real target) so DNS works under `--egress host` — needs a `gits-confine.sh` peer-profile tweak; OR
- Install `passt`/`pasta` and use `--egress proxy=` with a real userspace-net + allowlist (the proper H0c path).

## Bottom line
- **Solved:** the binary/toolchain + credential half of confined codex (Recipe D).
- **Open (blocks e2e):** the jailed peer has no working DNS/egress on this host → it cannot reach the model API. Confined-yolo spawn is **not end-to-end functional** until the jail's resolver/egress is fixed (a `gits-confine.sh` peer-DNS bind, or H0c `passt`).
- delamain Task 5's wrap (run codex through this invocation) is structurally implementable, but **cannot be validated** (Plan 2 Task 7 e2e) until the egress blocker is resolved.

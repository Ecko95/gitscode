# WSL2 Host Configuration for GITS

Checklist-style reference for running the GITS cockpit service inside WSL2 on a Windows host.
Covers `.wslconfig`, networking modes, and filesystem placement.

For Linux-native performance benchmarks (ext4 vs APFS, worktree speed, CPU overhead) see
[`docs/linux-remote-dev-performance.md`](linux-remote-dev-performance.md).

---

## 1. Recommended `.wslconfig`

Place this file at `C:\Users\<YourUser>\.wslconfig` (one file, Windows side).
**Changes only take effect after `wsl --shutdown` from PowerShell.**

```ini
[wsl2]
# How much RAM the VM can use. Set to ~60–70 % of physical RAM.
# The VM does not release pages back to Windows automatically unless
# autoMemoryReclaim is set (see [experimental] below).
memory=20GB

# Virtual CPU count. Match your physical core count for best throughput
# under concurrent sub-agent workloads.
processors=12

# NAT mode: WSL gets its own virtual NIC behind Windows NAT.
# localhostForwarding=true (default for NAT) lets Windows-side processes
# reach WSL services at localhost:<port> without any portproxy setup.
# This is what the gits-hosting scripts rely on by default.
networkingMode=nat
localhostForwarding=true

[experimental]
# Gradually reclaims idle WSL memory back to Windows.
# "gradual" is safe for long-running services; "dropcache" is more
# aggressive and can cause latency spikes.
autoMemoryReclaim=gradual

# Stores the WSL VHD as a sparse file so disk usage tracks actual data,
# not the full allocated size.
sparseVhd=true
```

### Common failure: the commented-out section header

```ini
# [wsl2]          ← this comment silently disables the ENTIRE [wsl2] section
memory=20GB       ← never applied
```

If your `.wslconfig` settings appear to have no effect, check that `[wsl2]` (and
`[experimental]`) are uncommented. Windows parses INI sections literally; a `#` before
the bracket means the section never opens and every key underneath is ignored.

### Applying changes

```powershell
wsl --shutdown
# wait ~8 seconds, then reopen your WSL terminal
```

---

## 2. Networking: NAT + localhostForwarding vs. mirrored

### NAT + localhostForwarding (default, what the scripts assume)

The gits-hosting scripts bind the cockpit service to `127.0.0.1:13773` inside WSL.
With `networkingMode=nat` and `localhostForwarding=true`, Windows automatically
forwards `localhost:13773` → WSL loopback. The `Set-GitsTailnetPortProxy.ps1` script
uses this path when run **without** `-UsePortProxy`:

```
WSL service (127.0.0.1:13773)
  ↓ localhostForwarding (automatic)
Windows localhost:13773
  ↓ tailscale serve --https=8443
tailnet (https://<machine>.ts.net:8443)
```

**Use this unless localhostForwarding is broken on your machine** (some VPN drivers
conflict with the Windows NAT adapter).

### When localhostForwarding breaks

If `Test-LoopbackHttp` fails and you are on NAT mode, run the portproxy variant
(requires an elevated PowerShell session):

```powershell
# Elevated PowerShell
.\Set-GitsTailnetPortProxy.ps1 -UsePortProxy
```

This resolves the WSL VM's dynamic IP via `wsl hostname -I` and installs a
`netsh interface portproxy` rule:
`127.0.0.1:13773 (Windows) → <WSL-IP>:13773`.

The downside: the WSL VM IP changes on every `wsl --shutdown`, so you must re-run the
script after each restart.

### mirrored networking (`networkingMode=mirrored`)

Available on Windows 11 22H2+ with WSL ≥ 2.0.5.

```ini
[wsl2]
networkingMode=mirrored
```

In mirrored mode WSL shares the Windows network stack directly — no NAT, no VM IP.
WSL services bound to `127.0.0.1` are reachable on Windows `127.0.0.1` natively, and
Tailscale running inside WSL sees the same tailnet as Windows Tailscale.

**Trade-offs for the gits-hosting scripts:**

|                               | NAT + localhostForwarding | mirrored              |
| ----------------------------- | ------------------------- | --------------------- |
| `localhostForwarding` needed  | yes                       | no (built-in)         |
| Windows portproxy fallback    | `-UsePortProxy` flag      | not needed            |
| Tailscale in WSL sees tailnet | no (separate NIC)         | yes                   |
| Script compatibility          | fully supported           | compatible, simpler   |
| Stability on older Windows    | good                      | requires Win 11 22H2+ |

If you run Tailscale inside WSL (rather than on Windows), mirrored mode is the better
choice. If you run Tailscale on Windows and use `Set-GitsTailnetPortProxy.ps1` to
publish the service, NAT + localhostForwarding is the tested default.

---

## 3. Filesystem: repos must live on ext4, never under `/mnt/c`

```
~/dev/projects/gitscode        ✓  ext4 — fast inotify, fast git
~/dev/projects/gitscode-hosted ✓  ext4 — deploy worktree, same rule

/mnt/c/Users/.../gitscode      ✗  9P over VirtioFS — 10–50× slower I/O
```

The default paths in `common.sh` already follow this rule:

```bash
GITS_HOSTING_DEFAULT_REPO="${HOME}/dev/projects/gitscode"
GITS_HOSTING_DEFAULT_WORKTREE="${HOME}/dev/projects/gitscode-hosted"
```

**Why it matters:**

- `git status` on a `/mnt/c` repo can take 5–30 s because every stat call crosses the
  9P filesystem boundary into the Windows NTFS driver.
- `inotify` does not fire for changes made from the Windows side, so file watchers
  (Vite HMR, the cockpit's asset server) miss updates silently.
- `bun install` and worktree creation are 10–50× faster on ext4. See
  [`docs/linux-remote-dev-performance.md`](linux-remote-dev-performance.md) for
  measured benchmarks.

**Symptom:** if status polls feel sluggish or the cockpit does not pick up rebuilt
assets, verify the worktree is not under `/mnt/`.

```bash
# Quick check
stat --file-system ~/dev/projects/gitscode | grep Type
# Should print: Type: ext2/ext3  (Linux reports ext4 as ext2 family)
```

---

## Quick-start checklist

- [ ] `C:\Users\<You>\.wslconfig` exists and `[wsl2]` header is **not** commented out
- [ ] `wsl --shutdown` run after any `.wslconfig` edit
- [ ] `networkingMode=nat` + `localhostForwarding=true` (or `mirrored` on Win 11 22H2+)
- [ ] Repo and deploy worktree are under `~/dev/...` (ext4), not `/mnt/c`
- [ ] `loginctl enable-linger $USER` run so the systemd user service survives logout
- [ ] `Set-GitsTailnetPortProxy.ps1` run from an elevated PowerShell to publish to tailnet

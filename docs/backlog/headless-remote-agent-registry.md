# Backlog: Headless Remote Agent Registry (`feat/gits-headless`)

**Status:** Shelved — solved by existing primitives  
**Branch:** `feat/gits-headless` (worktree: `~/dev/projects/gitscode-headless`)  
**Diverged from gits:** 2026-06-06 (6 commits of actual new work)  
**Rebase cost if revived:** Low — one trivial conflict in `bin.ts`

---

## What the branch built

A `t3 remote` CLI subcommand group that lets one headless GITS host act as a **control plane** provisioning GITS onto _other_ machines over SSH:

- `RemoteAgentRegistry` — persists saved remote agents to `userdata/remote-agents.json` (no secrets stored, atomic writes, Effect service)
- `cli/remote.ts` — `t3 remote add/list/status/remove`; `add` SSHes into a target, launches/reuses a remote `t3` server, issues a one-time pairing token, saves the record
- `packages/contracts/src/remoteAccess.ts` — `RemoteAgentRecord` + registry-file schemas (additive, 39 lines)
- `REMOTE.md` — docs

Reuses existing `packages/ssh` primitives (`launchOrReuseRemoteServer`, `issueRemotePairingToken`). Clean, tested code.

---

## Why it's shelved

### The use-case it targets

One headless machine that **spins up GITS on a fleet of other machines** — a fan-out/fleet control plane. Each managed target gets provisioned via SSH from the controller.

### The use-case the user actually has

A single GITS instance running on a **VPS or homelab**, reachable from a laptop over **Tailscale/SSH**. That already works today with no extra code:

```bash
# On the VPS / homelab machine:
t3 serve --host "$(tailscale ip -4)"

# On the laptop — open in browser or connect the desktop app:
# http://<tailscale-ip>:<port>
```

Tailscale provides the stable, secure address. `t3 serve --host` is already documented. This branch would add bookkeeping the user doesn't need for a single instance.

---

## WSL is a first-class hosting target

GITS already has a complete WSL hosting stack in `scripts/gits-hosting/`:

1. **`deploy-gits-tailnet-hosted.sh`** — builds GITS from the `gits` branch, installs it as a `systemd` user service (`gits-cockpit.service`) inside WSL, binds to `127.0.0.1:13773`
2. **`Set-GitsTailnetPortProxy.ps1`** — Windows-side PowerShell: resolves the WSL IPv4, sets up a `netsh portproxy` rule, and wires it into `tailscale serve` as HTTPS on the tailnet
3. **`externalLauncher.ts`** — server-side WSL detection (`WSL_DISTRO_NAME`/`WSL_INTEROP`): opens the app URL in the **Windows browser** via PowerShell automatically; gracefully degrades when no Linux terminal emulator exists

Full flow:

```
WSL gits-cockpit.service → 127.0.0.1:13773 → netsh portproxy → tailscale serve → tailnet HTTPS
```

Reachable from any device on the tailnet — browser or the Windows Electron app via Settings → Connections.

## Accessing GITS remotely — current options

| Client                 | Platform                  | How                                                                                                      |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Web browser            | Any (including Windows)   | `t3 serve --host <tailscale-ip>` → open URL                                                              |
| Desktop app (Electron) | macOS, Linux, **Windows** | Install the `.exe`/`.dmg`/`.AppImage` build; point it at the remote server URL in Settings → Connections |
| Mobile PWA             | iOS, Android              | Open the web URL in Safari/Chrome, "Add to Home Screen"                                                  |

The desktop app has explicit Windows support: `pwsh.exe`/`powershell.exe` shell detection, `.ico` icons, win32 path delimiters. A Windows installer (NSIS/Squirrel) is part of the release artifact pipeline.

---

## When to revive this

Revisit `feat/gits-headless` only if you want **one machine to manage GITS deployments across multiple targets** (e.g. a CI controller spinning up per-repo GITS instances, or an ops dashboard for a fleet). For a personal homelab with one server, `t3 serve --host` is the answer.

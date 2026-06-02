# GITS Tailnet Hosting Runbook

## Objective

Run the GITS cockpit from a clean, known build that restarts persistently and is reachable only through the Tailnet.

Canonical personal repo:

```text
https://github.com/Ecko95/gitscode
```

Hosted Tailnet URL:

```text
https://subject28.taild6d729.ts.net:8443/gits
```

## Current Model

The hosted cockpit uses three explicit layers:

```text
Windows Tailscale Serve on :8443 (tailnet only)
  -> http://127.0.0.1:13773
  -> WSL user systemd service gits-cockpit.service
  -> /home/joshua/dev/projects/t3code-gits-hosted
```

The WSL service binds to loopback only:

```bash
node apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 13773
```

This avoids a LAN-facing WSL listener while still allowing Windows Tailscale Serve to proxy to `127.0.0.1:13773`.

## Source And Deploy Worktrees

Interactive source worktree:

```text
/home/joshua/dev/projects/t3code-tailnet-hosting-refresh
```

Managed deploy worktree:

```text
/home/joshua/dev/projects/t3code-gits-hosted
```

Do not use the interactive checkout as the served worktree. The deploy script hard-resets the managed worktree to the selected remote branch and writes build metadata into the built server bundle.

Default deploy branch while this feature is under review:

```text
origin/feat/gits-tailnet-hosting-refresh
```

After this branch merges, switch the hosted source to:

```text
origin/main
```

## WSL Service

Install or refresh the user service:

```bash
cd /home/joshua/dev/projects/t3code-tailnet-hosting-refresh
./scripts/gits-hosting/install-wsl-user-service.sh \
  --repo /home/joshua/dev/projects/t3code-tailnet-hosting-refresh \
  --worktree /home/joshua/dev/projects/t3code-gits-hosted \
  --remote origin \
  --branch feat/gits-tailnet-hosting-refresh \
  --host 127.0.0.1 \
  --port 13773 \
  --service gits-cockpit.service \
  --t3code-home /home/joshua/.t3
```

Refresh the deploy worktree, build, write metadata, restart, and health-check:

```bash
cd /home/joshua/dev/projects/t3code-tailnet-hosting-refresh
./scripts/gits-hosting/deploy-gits-tailnet-hosted.sh \
  --repo /home/joshua/dev/projects/t3code-tailnet-hosting-refresh \
  --worktree /home/joshua/dev/projects/t3code-gits-hosted \
  --remote origin \
  --branch feat/gits-tailnet-hosting-refresh \
  --host 127.0.0.1 \
  --port 13773 \
  --service gits-cockpit.service \
  --t3code-home /home/joshua/.t3
```

The install script writes:

```text
~/.config/systemd/user/gits-cockpit.service
```

The unit includes:

```ini
WorkingDirectory=/home/joshua/dev/projects/t3code-gits-hosted
Environment=NODE_ENV=production
Environment=T3CODE_HOME=/home/joshua/.t3
Environment=GITS_BUILD_INFO_PATH=/home/joshua/dev/projects/t3code-gits-hosted/apps/server/dist/gits-build-metadata.json
ExecStart=<detected-node-path> apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 13773
Restart=on-failure
RestartSec=3
```

## Windows Tailscale Serve

Use Windows Tailscale Serve as the Tailnet entrypoint. The hardened default does not create a Windows portproxy because Windows localhost forwarding can reach the WSL loopback listener directly.

Run from Windows PowerShell:

```powershell
cd C:\Users\joshua\dev\projects\t3code-tailnet-hosting-refresh
powershell -ExecutionPolicy Bypass -File .\scripts\gits-hosting\Set-GitsTailnetPortProxy.ps1 `
  -LocalPort 13773 `
  -TailnetHttpsPort 8443
```

If Windows localhost forwarding is unavailable on a future machine, rerun from elevated PowerShell with `-UsePortProxy`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\gits-hosting\Set-GitsTailnetPortProxy.ps1 `
  -UsePortProxy `
  -WslDistro Ubuntu `
  -LocalPort 13773 `
  -TailnetHttpsPort 8443
```

The script enforces:

- Windows can reach `http://127.0.0.1:13773/gits`.
- `:8443` is not configured as a public Funnel route.
- No broad Windows portproxy exists for `0.0.0.0:13773`.
- Tailscale Serve reports `:8443` as `tailnet only`.
- Any optional portproxy uses loopback listen address `127.0.0.1` unless explicitly overridden.

Current expected Windows Tailscale shape:

```text
https://subject28.taild6d729.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:13773

https://subject28.taild6d729.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:5678
```

The public root Funnel is the existing n8n route and is separate from the GITS cockpit. GITS must remain on `:8443` as Tailnet-only.

## Version Visibility

The deploy script writes:

```text
/home/joshua/dev/projects/t3code-gits-hosted/apps/server/dist/gits-build-metadata.json
```

`GET /api/gits/build-info` exposes the active branch, commit, build time, dirty flag, and source path. The GITS cockpit Overview tab renders the same provenance so stale hosting is visible immediately.

Check it from WSL:

```bash
curl -fsS http://127.0.0.1:13773/api/gits/build-info | jq .
curl -fsS https://subject28.taild6d729.ts.net:8443/api/gits/build-info | jq .
```

## Cockpit Surfaces

The hosted cockpit currently includes:

- Overview with build provenance.
- Delamain peer fleet controls.
- Open GSD controls.
- Automode controls.
- Projects and runtime visibility.
- RTK output gateway documentation and server foundations.
- Skills Intelligence inventory for Codex, Claude, and Cursor local skill roots.

The Skills Intelligence tab currently supports inventory, missing-port signals, HERMES candidate signals, and browser-local ratings/reviews. Durable usage analytics and HERMES writeback remain follow-up work.

## Verification Checklist

WSL service:

```bash
systemctl --user is-active gits-cockpit.service
systemctl --user --no-pager --full status gits-cockpit.service
ss -ltnp | rg ':13773'
curl -fsS http://127.0.0.1:13773/gits >/dev/null
```

Tailnet route:

```bash
curl -fsS https://subject28.taild6d729.ts.net:8443/gits >/dev/null
curl -fsS https://subject28.taild6d729.ts.net:8443/api/gits/skills | jq '.totals'
```

Windows Tailscale:

```powershell
tailscale serve status
tailscale funnel status
netsh interface portproxy show v4tov4
```

Acceptance:

- `gits-cockpit.service` is active.
- WSL listener is `127.0.0.1:13773`, not `0.0.0.0:13773`.
- Tailnet URL returns `/gits`.
- Build info reports the expected branch and commit with `dirty: false`.
- `tailscale serve status` shows `:8443 (tailnet only)`.
- `tailscale funnel status` does not show `:8443` as `Funnel on`.
- Windows portproxy does not expose `0.0.0.0:13773`.

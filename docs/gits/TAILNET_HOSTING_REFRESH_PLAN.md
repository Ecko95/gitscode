# GITS Tailnet Hosting Refresh Plan

## Objective

Make the Tailnet-hosted GITS cockpit run from a known latest build, restart persistently, and remain reachable only through Tailnet.

The immediate issue is not Tailnet reachability: `https://subject28.taild6d729.ts.net:8443/gits` returns successfully. The issue is deployment provenance. The live process is serving a built artifact from an older dirty checkout, so the hosted cockpit may not include the latest GITS cockpit panels.

## Current Snapshot

Observed from WSL:

- Hosted Tailnet URL: `https://subject28.taild6d729.ts.net:8443/gits`
- Tailnet URL response: `HTTP/2 200`
- WSL `tailscale serve status`: `No serve config`
- WSL `tailscale funnel status`: `No serve config`
- Live GITS process cwd: `/home/joshua/dev/projects/t3code/apps/server`
- Live command: `node dist/bin.mjs serve --host 0.0.0.0 --port 13773`
- Live listener: `0.0.0.0:13773`
- Live repo checkout: `/home/joshua/dev/projects/t3code`
- Live repo branch: `feat/gits-readonly-foundation`
- Live repo head: `b94904b3`
- Live repo state: dirty with GITS branding/assets work
- Latest RTK/GITS integration branch: `feat/gits-rtk-output-gateway`
- Latest RTK/GITS integration head: `943e0c73`
- `origin/main` has been fast-forwarded to `943e0c73`, so main now includes both `feat/gits-readonly-foundation` and `feat/gits-rtk-output-gateway`.
- Hosting refresh implementation branch: `feat/gits-tailnet-hosting-refresh`

Interpretation:

- The working Tailnet route is likely Windows Tailscale Serve plus a Windows-to-WSL proxy, not WSL Tailscale Serve.
- The hosted cockpit is not running the latest RTK/GITS branch.
- The hosted cockpit is not running `bun run dev`; it is running `apps/server/dist/bin.mjs serve`.
- The current process is broad-bound inside WSL. Whether this is acceptable depends on the Windows portproxy/Firewall shape. It should be explicitly verified before calling the setup hardened.

## Cockpit Surface Clarification

The latest `feat/gits-rtk-output-gateway` branch includes GITS cockpit control surfaces for:

- Delamain peer fleet
- Open GSD
- Automode
- RTK docs/guidance and server-side RTK foundations

The future Skills Intelligence cockpit tab is not implemented yet. It is planned separately on `feat/gits-skills-intelligence`, which currently contains the plan document only.

So the hosting refresh can fix missing Delamain/Open GSD/Automode surfaces caused by stale hosting, but it will not add the Skills tab until that feature is implemented and merged into the deployed branch.

## Hosting Model

Use a dedicated deploy worktree, not the dirty interactive checkout.

Recommended deploy worktree:

```text
/home/joshua/dev/projects/t3code-gits-hosted
```

Recommended source branch for the next deploy:

```text
origin/feat/gits-tailnet-hosting-refresh
```

The systemd service should run a built artifact from this clean deploy worktree:

```bash
node apps/server/dist/bin.mjs serve --host 0.0.0.0 --port 13773
```

Why not use `bun run dev` for the persistent Tailnet target:

- The current Tailnet URL hits the server on `13773`, not Vite on `5733`.
- The server only redirects to the Vite dev server for loopback hostnames.
- Tailnet requests use the Tailnet hostname, so they are served from static/build assets.
- A dev server restart alone can still leave Tailnet users seeing stale static assets unless the build is refreshed or the Tailnet route targets Vite deliberately.

Use `bun run dev` for local iteration. Use built `dist/bin.mjs serve` for the persistent Tailnet cockpit.

## Build And Deploy Flow

The repo now carries reviewable deployment scripts under `scripts/gits-hosting/`.

1. Install or refresh the WSL user service from the interactive checkout:

```bash
cd /home/joshua/dev/projects/t3code
./scripts/gits-hosting/install-wsl-user-service.sh \
  --repo /home/joshua/dev/projects/t3code \
  --worktree /home/joshua/dev/projects/t3code-gits-hosted \
  --branch feat/gits-tailnet-hosting-refresh \
  --service gits-cockpit.service \
  --port 13773 \
  --t3code-home /home/joshua/.t3
```

2. Create or refresh the clean deploy worktree, build it, write metadata, and restart the user service:

```bash
cd /home/joshua/dev/projects/t3code
./scripts/gits-hosting/deploy-gits-tailnet-hosted.sh \
  --repo /home/joshua/dev/projects/t3code \
  --worktree /home/joshua/dev/projects/t3code-gits-hosted \
  --branch feat/gits-tailnet-hosting-refresh \
  --service gits-cockpit.service \
  --port 13773
```

Behavior:

- Fetches `origin/feat/gits-tailnet-hosting-refresh`
- Creates `/home/joshua/dev/projects/t3code-gits-hosted` as a managed detached worktree on first run
- Hard-resets the managed worktree to the remote branch on subsequent runs
- Runs `bun install --frozen-lockfile`
- Runs `bun run build --filter=t3`
- Writes build provenance to `/home/joshua/dev/projects/t3code-gits-hosted/apps/server/dist/gits-build-metadata.json`
- Restarts `gits-cockpit.service`
- Runs a local `curl -I http://127.0.0.1:13773/gits` health check when `curl` is available

Do not point these scripts at `/home/joshua/dev/projects/t3code` as the served worktree. That checkout is intentionally dirty and should remain available for interactive work.

## Systemd Service

`scripts/gits-hosting/install-wsl-user-service.sh` writes the unit to:

```text
~/.config/systemd/user/gits-cockpit.service
```

Installed unit shape:

```ini
[Unit]
Description=Hosted GITS cockpit
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/joshua/dev/projects/t3code-gits-hosted
Environment=NODE_ENV=production
Environment=T3CODE_HOME=/home/joshua/.t3
Environment=GITS_BUILD_INFO_PATH=/home/joshua/dev/projects/t3code-gits-hosted/apps/server/dist/gits-build-metadata.json
ExecStart=<detected-node-path> apps/server/dist/bin.mjs serve --host 0.0.0.0 --port 13773
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Notes:

- `T3CODE_HOME=/home/joshua/.t3` preserves current state behavior because the existing process has no explicit `T3CODE_HOME` and therefore uses the default.
- `GITS_BUILD_INFO_PATH` points at the metadata file written by the deploy script, so the hosted cockpit can prove which branch/commit it is serving.
- The install script rewrites `ExecStart` using the current `command -v node`, so the unit refresh does not stay pinned to an obsolete Node path.
- If linger is not already enabled, the install script prints `sudo loginctl enable-linger $USER`.

## Tailnet Exposure Model

Current evidence points to Windows Tailscale as the active Serve owner. Keep that split for now:

```text
Tailnet HTTPS :8443
  -> Windows Tailscale Serve
  -> Windows loopback portproxy 127.0.0.1:13773
  -> WSL GITS server on <WSL-IP>:13773
```

Configure the Windows side from an elevated PowerShell session:

```powershell
cd C:\Users\joshua\dev\projects\t3code
powershell -ExecutionPolicy Bypass -File .\scripts\gits-hosting\Set-GitsTailnetPortProxy.ps1 `
  -WslDistro Ubuntu `
  -LocalPort 13773 `
  -TailnetHttpsPort 8443
```

Script behavior:

- Resolves the current WSL IPv4 address
- Replaces the Windows `netsh interface portproxy` rule for `127.0.0.1:13773`
- Checks `tailscale funnel status` and refuses to continue if Funnel appears to use `:8443`
- Runs `tailscale serve --bg --yes --https=8443 http://127.0.0.1:13773`
- Prints `tailscale serve status`, `tailscale funnel status`, and `netsh interface portproxy show v4tov4`

Required Windows-side verification after the script runs:

```powershell
tailscale serve status
tailscale funnel status
netsh interface portproxy show v4tov4
Get-NetFirewallRule | Where-Object DisplayName -match 'GITS|13773|8443|Tailscale'
```

Security requirements:

- `tailscale funnel status` must not show `:8443`.
- Windows portproxy must listen on `127.0.0.1:13773`, not `0.0.0.0:13773`.
- No Windows firewall rule should expose `13773` to LAN.
- `8443` should be reachable through Tailscale Serve, not as a normal LAN listener.

The WSL process may need to listen on `0.0.0.0:13773` if Windows portproxy connects to the WSL IP. If strict WSL loopback binding is required, switch to WSL-native Tailscale Serve instead of Windows portproxy.

## Version Visibility

Current implementation:

- `scripts/gits-hosting/deploy-gits-tailnet-hosted.sh` writes `apps/server/dist/gits-build-metadata.json` with:
  - branch
  - source ref
  - commit SHA
  - short SHA
  - build time
  - tracked dirty flag
  - source repo path
  - worktree path
  - Node version
  - Bun version
- `GET /api/gits/build-info` exposes normalized build metadata without auth.
- The GITS cockpit Overview tab renders the provenance when the endpoint is available and degrades cleanly when it is missing.

Acceptance:

- The hosted page visibly reports `feat/gits-tailnet-hosting-refresh` and the current commit.
- The operator can tell immediately whether Tailnet is showing a stale build.

## Rollout Plan

1. Run `./scripts/gits-hosting/install-wsl-user-service.sh --repo /home/joshua/dev/projects/t3code --worktree /home/joshua/dev/projects/t3code-gits-hosted --branch feat/gits-tailnet-hosting-refresh --service gits-cockpit.service --port 13773 --t3code-home /home/joshua/.t3`.
2. Run `./scripts/gits-hosting/deploy-gits-tailnet-hosted.sh --repo /home/joshua/dev/projects/t3code --worktree /home/joshua/dev/projects/t3code-gits-hosted --branch feat/gits-tailnet-hosting-refresh --service gits-cockpit.service --port 13773`.
3. Stop the manual `dist/bin.mjs serve` process once the user service is healthy.
4. Run `powershell -ExecutionPolicy Bypass -File .\scripts\gits-hosting\Set-GitsTailnetPortProxy.ps1 -WslDistro Ubuntu -LocalPort 13773 -TailnetHttpsPort 8443` from an elevated Windows PowerShell session.
5. Verify local health: `curl -I http://127.0.0.1:13773/gits`.
6. Verify Tailnet health: `curl -k -I https://subject28.taild6d729.ts.net:8443/gits`.
7. Verify cockpit surfaces:
   - Delamain peer fleet visible
   - Open GSD visible
   - Automode visible
   - Overview tab visible
   - `/api/gits/build-info` shows the latest deployed commit
8. Verify Windows Tailscale Serve remains Tailnet-only and Funnel is off for `:8443`.

## Open Decisions

- After this branch is reviewed, should the hosted source switch back to `main`, or should `feat/gits-tailnet-hosting-refresh` remain the preview channel until Skills Intelligence lands?
- Should the hosted cockpit use production build only, or should there be a separate Tailnet dev preview route that points directly to Vite?
- Should the Skills Intelligence branch be implemented before the next Tailnet deploy, or should we first deploy the already-implemented Delamain/Open GSD/Automode surfaces?
- Should the Windows portproxy be the long-term bridge, or should we move Serve into WSL for a stricter loopback-only Linux service?

## Acceptance Criteria

- The hosted Tailnet URL serves a build from a clean deploy worktree.
- Hosted build provenance is visible from the cockpit.
- The hosted build includes the latest implemented GITS cockpit surfaces.
- The service restarts through WSL user systemd.
- No manual terminal process is required to keep GITS online.
- Windows Tailscale Serve exposes the cockpit only to the Tailnet.
- Public Funnel remains disabled for the GITS cockpit route.
- The dirty interactive checkout remains untouched.

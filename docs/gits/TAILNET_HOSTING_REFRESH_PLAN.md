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
origin/feat/gits-rtk-output-gateway
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

Create a deploy script in the next implementation slice:

```bash
#!/usr/bin/env bash
set -euo pipefail

cd /home/joshua/dev/projects/t3code-gits-hosted
git fetch origin feat/gits-rtk-output-gateway
git checkout feat/gits-rtk-output-gateway
git reset --hard origin/feat/gits-rtk-output-gateway
bun install --frozen-lockfile
bun run build
systemctl --user restart gits-cockpit.service
systemctl --user status --no-pager gits-cockpit.service
curl -I --max-time 8 http://127.0.0.1:13773/gits
curl -k -I --max-time 8 https://subject28.taild6d729.ts.net:8443/gits
```

Do not run this against `/home/joshua/dev/projects/t3code`; that checkout is dirty and should stay available for interactive work.

## Systemd Service

Create a WSL user service:

```ini
[Unit]
Description=GITS Cockpit
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/joshua/dev/projects/t3code-gits-hosted
Environment=NODE_ENV=production
Environment=T3CODE_HOME=/home/joshua/.t3
ExecStart=/home/joshua/.nvm/versions/node/v24.12.0/bin/node apps/server/dist/bin.mjs serve --host 0.0.0.0 --port 13773
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

Notes:

- `T3CODE_HOME=/home/joshua/.t3` preserves current state behavior because the existing process has no explicit `T3CODE_HOME` and therefore uses the default.
- User linger is already enabled, so the service can survive terminal logout.
- The first implementation slice should confirm the exact Node path at deploy time instead of hard-coding a stale version forever.

## Tailnet Exposure Model

Current evidence points to Windows Tailscale as the active Serve owner. Keep that split for now:

```text
Tailnet HTTPS :8443
  -> Windows Tailscale Serve
  -> Windows loopback portproxy 127.0.0.1:13773
  -> WSL GITS server on <WSL-IP>:13773
```

Required Windows-side verification:

```powershell
tailscale serve status
tailscale funnel status
netsh interface portproxy show v4tov4
Get-NetFirewallRule | ? DisplayName -match 'GITS|13773|8443|Tailscale'
```

Security requirements:

- `tailscale funnel status` must not show `:8443`.
- Windows portproxy must listen on `127.0.0.1:13773`, not `0.0.0.0:13773`.
- No Windows firewall rule should expose `13773` to LAN.
- `8443` should be reachable through Tailscale Serve, not as a normal LAN listener.

The WSL process may need to listen on `0.0.0.0:13773` if Windows portproxy connects to the WSL IP. If strict WSL loopback binding is required, switch to WSL-native Tailscale Serve instead of Windows portproxy.

## Version Visibility

Add build provenance before relying on the hosted cockpit for operations.

Recommended implementation:

- Generate a build metadata file during deploy or build:
  - branch
  - commit SHA
  - build time
  - dirty flag
  - source worktree path
- Expose it through a small server endpoint, for example `/api/gits/build-info`.
- Render it in the GITS cockpit header or footer.

Acceptance:

- The hosted page visibly reports `feat/gits-rtk-output-gateway` and the current commit.
- The operator can tell immediately whether Tailnet is showing a stale build.

## Rollout Plan

1. Prepare the clean deploy worktree from `origin/feat/gits-rtk-output-gateway`.
2. Run `bun install --frozen-lockfile`.
3. Run `bun run build`.
4. Add build provenance endpoint/UI.
5. Create and enable `gits-cockpit.service`.
6. Stop the manual `dist/bin.mjs serve` process.
7. Start `gits-cockpit.service`.
8. Verify local health: `curl -I http://127.0.0.1:13773/gits`.
9. Verify Tailnet health: `curl -k -I https://subject28.taild6d729.ts.net:8443/gits`.
10. Verify cockpit surfaces:
    - Delamain peer fleet visible
    - Open GSD visible
    - Automode visible
    - Build info shows the latest deployed commit
11. Verify Windows Tailscale Serve remains Tailnet-only and Funnel is off for `:8443`.

## Open Decisions

- Should the deployed source branch remain `feat/gits-rtk-output-gateway`, or should we create a longer-lived `gits-hosted` branch that merges RTK, Skills, and future cockpit features?
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

# VPS / Native Linux Hosting for GITS

Reference for running the GITS cockpit on a native Linux host (VPS, bare metal, or
any systemd-capable machine where `WSL_DISTRO_NAME` is unset).

For WSL2 on Windows see [`docs/wsl-hosting.md`](wsl-hosting.md).

---

## Topology

```
gits-cockpit.service (systemd user unit)
  binds 127.0.0.1:13773
      ↓
tailscale serve --https=8443 → http://127.0.0.1:13773
  (runs on the same Linux host, no Windows portproxy needed)
      ↓
tailnet (https://<machine>.ts.net:8443)   — tailnet only, no Funnel
```

This Serve mapping is a **Tailnet/private endpoint** for the GITS cockpit only. Keep project app ports on loopback. Open them as **In GITS (VPS browser)**, or as **Local via SSH (this computer only)** from a Desktop SSH environment. Native preview endpoints remain unavailable pending separate origin-isolation approval; do not add same-host Serve mappings for app ports, and never treat them as **Public**.

The key difference from WSL: `tailscale` runs natively on the same Linux host as the
service, so `configure-tailscale-serve.sh` can wire the ingress directly without any
Windows-side step.

---

## Prerequisites

- systemd user units enabled (`loginctl enable-linger $USER`)
- Tailscale installed and authenticated (`tailscale up`)
- Node.js ≥ 22 and Bun on `PATH`
- The gitscode repo checked out at `$HOME/dev/projects/gitscode` (ext4, not a network FS)

---

## First-time setup

```bash
# 1. Install the systemd user unit
scripts/gits-hosting/install-gits-user-service.sh --start

# 2. Wire tailscale serve (native Linux only — skipped automatically on WSL)
scripts/gits-hosting/configure-tailscale-serve.sh

# 3. Deploy origin/gits and start the service
scripts/gits-hosting/deploy-subject28-gits.sh
```

`deploy-subject28-gits.sh` runs all three steps in order. On subsequent deploys a
single call is sufficient.

---

## Ingress: configure-tailscale-serve.sh

`configure-tailscale-serve.sh` is a no-op when `WSL_DISTRO_NAME` is set, so it is
safe to call unconditionally from any wrapper script.

```
scripts/gits-hosting/configure-tailscale-serve.sh [options]

  --host HOST               Cockpit bind host. Default: 127.0.0.1
  --port PORT               Cockpit bind port. Default: 13773
  --tailnet-https-port PORT HTTPS port on the tailnet. Default: 8443
  --skip-serve              Run guards only; do not change tailscale serve.
  --verify-only             Same as --skip-serve (no config changes).
```

The script:

1. Checks that Funnel is not enabled on the HTTPS port (refuses if it is).
2. Calls `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<port>`.
3. Verifies the resulting serve config is "tailnet only" — aborts if Funnel appears.

---

## Dev servers spawned by GITS on a tailnet host

**Symptom.** You open a dev server from the cockpit and the browser shows
`Blocked request. This host is not allowed.` (HTTP 403). Vite (and most modern dev
servers) validate the `Host` header; when the page is reached over Tailscale the
header is `vps-eu.taild6d729.ts.net`, not `localhost`, so the request is rejected.

**Fix.** Tell GITS which hostnames dev servers should accept. It injects them at
spawn time — no project's `vite.config` is ever edited.

```bash
# systemd user units inherit nothing from your shell, so set these when (re)installing
# the unit — install-gits-user-service.sh bakes any that are non-empty into it:
GITS_DEV_ALLOWED_HOSTS=.taild6d729.ts.net \
GITS_DEV_BIND_HOST=127.0.0.1 \
  scripts/gits-hosting/install-gits-user-service.sh --start
```

| Setting                 | Env var                    | `.gits/dev-commands.json`  | Default     |
| ----------------------- | -------------------------- | -------------------------- | ----------- |
| Allowed `Host` headers  | `GITS_DEV_ALLOWED_HOSTS`   | `dev.allowedHosts` (array) | _(none)_    |
| Bind address            | `GITS_DEV_BIND_HOST`       | `dev.bindHost`             | `127.0.0.1` |
| Allow `tailscale serve` | `GITS_DEV_TAILSCALE_SERVE` | _(server-wide only)_       | `false`     |

The env var is a comma-separated list. A per-project `.gits/dev-commands.json`
replaces the server-wide list for that repo:

```json
{
  "dev": { "allowedHosts": [".taild6d729.ts.net"], "bindHost": "127.0.0.1" },
  "commands": [{ "id": "web-dev", "name": "Web dev", "command": "bun run dev", "port": 5175 }]
}
```

**How it is injected.** The dev-command runner exports
`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` (read by Vite 7+ without touching the
project config), exports `HOST` as a bind hint for webpack/CRA-style servers, and
appends `--host <bindHost> --port <port> --strictPort` to commands it recognises
(direct `vite …`, or `bun|npm|pnpm|yarn run <script>` after `--`) when the command
has an explicit `port`.

_Escape hatch._ Frameworks with their own allow-list flag can read
`GITS_DEV_ALLOWED_HOSTS` from their own config — it is exported into the dev server's
environment:

```js
// next.config.js
allowedDevOrigins: (process.env.GITS_DEV_ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
// webpack.config.js
devServer: { allowedHosts: (process.env.GITS_DEV_ALLOWED_HOSTS ?? "").split(",").filter(Boolean) },
```

Note: Vite 7 treats the injected value as a **single** host, Vite 8 splits on commas.
On Vite 7, keep the list to one entry (the leading-dot tailnet wildcard covers it).

### Optional: publish a dev server on the tailnet automatically

> Note the topology policy above: app-port Serve mappings are **not** the default posture.
> This flag exists for hosts that have accepted that trade-off; mappings stay tailnet-only
> (never Funnel) and are torn down when the dev server exits.

Off by default because `tailscale serve` needs root or
`tailscale set --operator=$(whoami)`. Enable it server-wide and opt in per command:

```bash
GITS_DEV_TAILSCALE_SERVE=true
```

```json
{
  "id": "web-dev",
  "name": "Web dev",
  "command": "bun run dev",
  "port": 5175,
  "publishOnTailnet": true,
  "servePort": 8444
}
```

The runner then registers and deregisters the mapping around the dev server's
lifetime — equivalent to running these by hand:

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:5175   # on
tailscale serve --https=8444 off                          # off
```

Use a `servePort` distinct from the cockpit's `8443`. The cockpit shows the resulting
`https://<host>.<tailnet>.ts.net:8444/` once it is up. If `tailscale` is missing or
lacks permission, the dev server still starts and the runner logs a warning.

---

## Service unit

`install-gits-user-service.sh` generates a systemd user unit identical to the WSL
variant. The same `MemoryMax` / `--max-old-space-size` defaults apply; override with
the provided VPS scale profile for dedicated hosts.

---

## VPS scale profile

`scripts/gits-hosting/profiles/vps.env` ships recommended values for a **dedicated
32 GB VPS**. Source it before running the install script:

```bash
set -a
source scripts/gits-hosting/profiles/vps.env
set +a
scripts/gits-hosting/install-gits-user-service.sh --start
```

Or inline (single command):

```bash
env $(grep -v '^#' scripts/gits-hosting/profiles/vps.env | xargs) \
  scripts/gits-hosting/install-gits-user-service.sh --start
```

### Profile values

| Variable                       | Profile value | WSL default | Justification                                                                                        |
| ------------------------------ | ------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `GITS_HOSTING_MEMORY_MAX`      | `24G`         | `6G`        | Leaves ~8 GB for OS + Tailscale + MCP sidecars on a 32 GB host                                       |
| `GITS_HOSTING_NODE_HEAP_MB`    | `16384`       | `4096`      | Gives V8 room for large concurrent conversation histories; stays well below `MemoryMax`              |
| `GITS_AUTOMODE_DRIVER_TICK_MS` | `2000`        | `5000`      | Halves automode reaction latency; safe when the host has CPU headroom with no competing desktop load |

Adjust values for your actual RAM before sourcing. The only hard constraint is
`GITS_HOSTING_NODE_HEAP_MB` (MiB) × 1.07 < `GITS_HOSTING_MEMORY_MAX` — leave
overhead for V8 off-heap allocations.

### Knobs that do not yet exist

The following would be useful on a VPS but are not yet env-var-tunable
(tracked for future work):

- `ProviderSessionReaper` sweep interval and inactivity threshold — hardcoded to
  5 min / 30 min in `apps/server/src/provider/Layers/ProviderSessionReaper.ts`;
  a shorter sweep (e.g. 60 s) would reclaim slots faster under heavy concurrent load.

---

## Comparing WSL and native-Linux topologies

| Step                                     | WSL2 (Windows host)                             | Native Linux / VPS                     |
| ---------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| systemd user unit                        | `install-gits-user-service.sh`                  | `install-gits-user-service.sh` (same)  |
| Deploy + build                           | `deploy-gits-tailnet-hosted.sh`                 | `deploy-gits-tailnet-hosted.sh` (same) |
| Tailnet ingress                          | `Set-GitsTailnetPortProxy.ps1` (Windows, admin) | `configure-tailscale-serve.sh` (Linux) |
| Portproxy needed                         | optional (when localhostForwarding breaks)      | never                                  |
| `WSL_DISTRO_NAME` set                    | yes                                             | no                                     |
| `configure-tailscale-serve.sh` behaviour | no-op (exits 0)                                 | wires `tailscale serve`                |

---

## Quick-start checklist

- [ ] `sudo loginctl enable-linger $USER` (survive logout)
- [ ] `tailscale up` and authenticated
- [ ] Repo at `~/dev/projects/gitscode` on a local filesystem (not NFS/CIFS)
- [ ] `scripts/gits-hosting/deploy-subject28-gits.sh` run successfully
- [ ] `tailscale serve status` shows `:8443` → `http://127.0.0.1:13773` (tailnet only)
- [ ] `curl -s http://127.0.0.1:13773/gits` returns HTTP 200
- [ ] `https://subject28.taild6d729.ts.net:8443/api/gits/build-info` reachable from another tailnet node

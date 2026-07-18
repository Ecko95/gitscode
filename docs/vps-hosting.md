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

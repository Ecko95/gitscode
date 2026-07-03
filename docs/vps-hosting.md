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
env vars for higher-memory VPS tiers (W6.3):

```bash
GITS_HOSTING_MEMORY_MAX=12G \
GITS_HOSTING_NODE_HEAP_MB=10240 \
scripts/gits-hosting/install-gits-user-service.sh --start
```

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

# Self-Hosting

The recommended remote setup is a trusted private mesh network such as a tailnet. That gives the server a stable address, transport security at the network layer, and less exposure than opening the server directly to the public internet.

For headless use, run `t3 serve` on the host:

```bash
npx t3 serve --host "$(tailscale ip -4)"
```

`t3 serve` runs without a GUI and prints a connection string, a pairing token, a pairing URL, and a QR code. Pairing is a token exchange: the server issues a one-time owner pairing token, the remote device exchanges it, and the server creates an authenticated session for that device. Later access is session-based.

Use `t3 auth` to manage access after pairing. It can issue additional pairing credentials, inspect active sessions, and revoke credentials or sessions you no longer trust.

## Remote localhost access

In a saved remote environment, `localhost` means the machine running GITS and the coding agent—not the phone or browser displaying the UI. The Ports & Browser panel uses these access labels:

- **In GITS (VPS browser)** — open the exact HTTP(S) URL in GITS-managed Chromium on the remote host. The client receives a scoped viewer ticket; the app port is not published.
- **Local via SSH (this computer only)** — available only from GITS Desktop for an SSH-backed environment. Desktop creates a managed `ssh -L` forward bound to `127.0.0.1`; OAuth callbacks keep their exact required port.
- **Tailnet/private endpoint** — an explicitly configured endpoint reachable only by devices allowed by its network policy. GITS does not create one automatically for an observed port.
- **Public** — internet-reachable exposure. GITS does not create public tunnels or enable Tailscale Funnel automatically.

Only the first two access paths are available for discovered remote ports in this release. Closing the panel does not stop an unmanaged listener. Archiving or deleting a thread and shutting down GITS do release browser tickets, helpers, provider sign-in sessions, and SSH forwards owned by GITS.

Native preview endpoints remain unavailable pending separate origin-isolation approval. Do not add a same-host Tailscale Serve mapping for an app port: GITS session cookies are host-scoped across ports, and the required cookie stripping, request-origin checks, and WebSocket origin enforcement are not yet a supported preview boundary. The Tailscale Serve mapping below is for the GITS cockpit only.

## Remote authentication

- Codex subscription sign-in uses a device code. Open the verification page on any trusted device and enter the one-time code.
- Claude subscription sign-in uses its remote browser flow and accepts the manual authorization code when the callback cannot reach the host.
- GitHub CLI sign-in uses GitHub's device flow.
- OpenCode shows only the authentication methods reported by the connected OpenCode server.

These sign-in sessions belong to the initiating connection and expire automatically. GITS keeps transient session state; the provider runtime owns the resulting credentials.

Codex MCP authentication is a separate downstream flow. Set `T3CODE_MCP_OAUTH_CALLBACK_URL` to the advertised HTTPS GITS origin to offer the Authenticate action. GITS enables it only when the callback endpoint is HTTPS and the temporary listener can be proven private. Each attempt gets one short-lived callback lease; authorization codes and tokens are not persisted by GITS.

For Tailscale HTTPS ingress, `npx t3 serve --tailscale-serve` configures HTTPS port 443 by default and advertises a MagicDNS URL such as `https://machine.tailnet.ts.net/`. Use `--tailscale-serve-port` to choose another HTTPS port. The desktop app can detect Tailscale endpoints and can set up the same server-side behavior from Settings.

For VPS or native Linux hosting, the documented topology runs `gits-cockpit.service` as a systemd user unit bound to `127.0.0.1:13773`, then uses:

```bash
tailscale serve --bg --yes --https=8443 http://127.0.0.1:13773
```

The native Linux script refuses to continue if Funnel is enabled for that port. A dedicated 32 GB profile is available at `scripts/gits-hosting/profiles/vps.env`.

For WSL2 hosting, the cockpit binds `127.0.0.1:13773` inside WSL. The recommended network setup is `networkingMode=nat` with `localhostForwarding=true`, with a portproxy fallback if localhost forwarding is broken. Mirrored mode is supported on Windows 11 22H2+ with a recent WSL. Keep repos on ext4 under `~/dev`; repos under `/mnt/c` are documented as much slower and can miss file watcher updates.

## Independent release gates and rollback

Remote-access slices are additive. Roll one back at its own capability boundary instead of disabling terminals or provider health checks:

| Feature                         | Disable or roll back at                                                                                | What remains available                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Codex MCP callback helper       | Unset `T3CODE_MCP_OAUTH_CALLBACK_URL`; the capability reports unavailable and starts no helper.        | MCP inventory and normal provider sessions         |
| Supervised-browser link routing | Withhold the browser-preview routes/RPC and the client remote-loopback action together.                | Terminal output and ordinary external links        |
| Provider sign-in adapters       | Omit the provider's optional auth adapter/methods while retaining its probe and model discovery.       | Existing credentials and provider status           |
| Desktop auxiliary forwards      | Hide **Local via SSH (this computer only)** and omit the remote-URL SSH IPC method together.           | Base Desktop SSH connection and terminal streaming |
| Ports inventory                 | Advertise `capabilities.ports` as `false` or omit it; older clients already decode absence as `false`. | Terminal and provider RPCs                         |

There is no native-preview or public-exposure gate to enable in this release.

Sources: `REMOTE.md`, `docs/vps-hosting.md`, `docs/wsl-hosting.md`.

# Self-Hosting

The recommended remote setup is a trusted private mesh network such as a tailnet. That gives the server a stable address, transport security at the network layer, and less exposure than opening the server directly to the public internet.

For headless use, run `t3 serve` on the host:

```bash
npx t3 serve --host "$(tailscale ip -4)"
```

`t3 serve` runs without a GUI and prints a connection string, a pairing token, a pairing URL, and a QR code. Pairing is a token exchange: the server issues a one-time owner pairing token, the remote device exchanges it, and the server creates an authenticated session for that device. Later access is session-based.

Use `t3 auth` to manage access after pairing. It can issue additional pairing credentials, inspect active sessions, and revoke credentials or sessions you no longer trust.

For Tailscale HTTPS ingress, `npx t3 serve --tailscale-serve` configures HTTPS port 443 by default and advertises a MagicDNS URL such as `https://machine.tailnet.ts.net/`. Use `--tailscale-serve-port` to choose another HTTPS port. The desktop app can detect Tailscale endpoints and can set up the same server-side behavior from Settings.

For VPS or native Linux hosting, the documented topology runs `gits-cockpit.service` as a systemd user unit bound to `127.0.0.1:13773`, then uses:

```bash
tailscale serve --bg --yes --https=8443 http://127.0.0.1:13773
```

The native Linux script refuses to continue if Funnel is enabled for that port. A dedicated 32 GB profile is available at `scripts/gits-hosting/profiles/vps.env`.

For WSL2 hosting, the cockpit binds `127.0.0.1:13773` inside WSL. The recommended network setup is `networkingMode=nat` with `localhostForwarding=true`, with a portproxy fallback if localhost forwarding is broken. Mirrored mode is supported on Windows 11 22H2+ with a recent WSL. Keep repos on ext4 under `~/dev`; repos under `/mnt/c` are documented as much slower and can miss file watcher updates.

Sources: `REMOTE.md`, `docs/vps-hosting.md`, `docs/wsl-hosting.md`.

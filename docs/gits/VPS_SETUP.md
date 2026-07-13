# GITS Autonomy VPS — Provisioning & Hardening Runbook (Phase 0)

> Status: runbook · Written 2026-07-13 from a 3-agent research pass (EU providers/pricing, workload sizing, security posture — all prices verified July 2026).
> Serves: `docs/brainstorms/off-hours-autonomy.md` phase 0 (decisions 1, 17, 19, 21, 22) and supersedes the "Temporary VPS Setup" sketch in `docs/gits-vps-home-server-and-itx-build-report.md` for the VPS path. The long-term "repurpose the 3700X as permanent home server" plan is unchanged.

## Decision summary

**Delivered 2026-07-13: netcup RS 2000 G12** — 8 **dedicated** AMD EPYC 9645 cores / 16 GB DDR5 **ECC** / 512 GB NVMe, Nuremberg, **€18.01/mo net (€21.79 incl. 21% ES VAT)**, monthly term, IPv4 included. The research pick was Hetzner CX43/CX53, but the CX (cost-optimized) line was sold out in every location and the post-hike CPX/CCX lines cost 4–5× — so the operator moved to the netcup Root Server line; the RS 4000 (32 GB) was the intent, the RS 2000 was ordered by mistake and **kept deliberately** — it matches the sizing analysis exactly (peak ≈ 7 GB) and the T&Cs (§3) allow an upgrade-anytime to RS 4000 with unused payments reimbursed if the daytime-headroom ceiling is ever felt. Knock-ons: dedicated cores retire the CPU-steal caveat entirely; peer `MemoryMax` stays 4G (6G possible briefly for the heaviest Playwright shards); 512 GB is ~10× the steady-state estimate; **no elastic resize** — growth path is the in-contract tier upgrade. Ubuntu 24.04.4 UEFI installed; root key-auth bootstrapped; operator-machine ssh alias `vps-eu` configured.

| Rank | Option                      | Spec                                    | €/mo          | Why / why not                                                                                                                                                                                                              |
| ---- | --------------------------- | --------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Hetzner CX43**            | 8 vCPU x86 shared, 16 GB, 160 GB        | 16.49         | Elastic resize + best cloud API/snapshots; right-sized for the ratified sequential design (`maxActivePeers: 1`); security posture below is Hetzner-anchored                                                                |
| 2    | **netcup RS 2000 G12**      | 8 **dedicated** EPYC, 16 GB ECC, 512 GB | 21.43         | Zero CPU-steal risk for nightly test spikes + 3× the disk; but no elastic API (upgrade = migrate), DE/AT/NL only, can sell out                                                                                             |
| 3    | OVH VPS-4                   | 8 vCPU shared, 24 GB, 200 GB            | 19.96         | The UK-London / Madrid-DC option if residency ever matters; free daily backup                                                                                                                                              |
| —    | Contabo VPS 30              | 8 vCPU, 24 GB, 200 GB                   | 14.00         | Rejected: oversubscription = CPU steal exactly during the nightly CI window                                                                                                                                                |
| —    | Hetzner CCX23 / CAX31 (ARM) | dedicated / ARM                         | 85.99 / 20.99 | CCX tripled in the June-2026 price shock; ARM now costs _more_ than x86 and adds two real landmines (Playwright `channel:'chrome'` has no ARM Linux build; electron-builder packaging needs x86 FPM). **x86, unambiguous** |

Reconciliation with the standing EX44-1-LTD decision (dedicated, 64 GB, €57.30): that was sized before the off-hours design ratified sequential execution (≤1 peer, ≤3 goals/night, 90 min caps). Peak concurrent working set for the autonomy stack measures ~7 GB — the RS 2000's 16 GB matches that sizing exactly; heavy daytime interactive load on the same box is the one thing deferred to the RS 4000 upgrade path.

RAM/disk rationale (from the sizing pass): peak ≈ 7 GB (GITS + MCP children ~1.5, delamain 0.3, peer scope capped 4.0, Hermes 0.5, herdr/OS 0.9) → 16 GB leaves ~9 GB page cache; steady-state disk ≈ 38–50 GB (3 clones, worktrees, node_modules, Playwright + build caches, rollouts) → 160 GB absorbs sprawl; grow later with a Block Volume (€0.057/GB/mo), not a plan bump.

## Remote access model (the whole answer)

1. **Tailscale SSH** — primary path from every trusted device (`tailscale up --ssh`).
2. **OpenSSH over the tailnet** — independent fallback, key-only, never public. Two decoupled paths: a bad ACL edit or a broken sshd_config is an inconvenience, not a lockout.
3. **herdr** — rides SSH; it has **no web UI and no TCP port** (control plane is a Unix socket). `herdr --remote ssh://ops@vps-eu` from the laptop attaches over the tailnet with zero extra exposure. Do not reverse-proxy or `tailscale serve` it.
4. **GITS cockpit** — `tailscale serve` (tailnet-only HTTPS; never `funnel`) via `scripts/gits-hosting/deploy-gits-tailnet-hosted.sh` — the native-Linux path, no Windows portproxy.
5. **Break-glass** — netcup SCP remote console (hypervisor-level, works with all firewalls down). SCP + root passwords live in the password manager.

Nothing else. No public ports, no RDP/VNC service, no mosh, no code-server. Telegram (long-polling) and GitHub are pure-outbound.

## 1. Create the server

- netcup → Root Server **RS 2000 G12** (delivered 2026-07-13), Ubuntu 24.04.4 UEFI image installed via SCP → Media/Images (hostname `vps-eu`, locale en_US.UTF-8; the installer ignored the timezone choice — §2 re-pins Europe/London), **IPv4 included**, monthly term. Root SSH key installed via ssh-copy-id; operator machine has a `vps-eu` alias in `~/.ssh/config` pointing at the key.
- **On handover, in the SCP panel first**: enable the netcup firewall with an **empty inbound ruleset** (deny-all; stateful, default outbound allow). Optional later: inbound `UDP 41641` if DERP-relay latency ever bites; interactive SSH/TUI is fine on DERP.
- Locate the **remote console** and **rescue system** in the SCP panel; set and vault the SCP + root passwords for break-glass. Take a first snapshot once the base install is clean.

## 2. Base system

```bash
adduser ops && usermod -aG sudo ops        # work as ops from here on
timedatectl set-timezone Europe/London     # decision: TZ pinned explicitly
loginctl enable-linger ops                 # user-scope systemd units survive logout
apt update && apt full-upgrade -y
apt install -y unattended-upgrades git tmux curl build-essential
```

`unattended-upgrades`: security pocket only, and **`Automatic-Reboot "false"`** — a 04:00 auto-reboot would kill an in-flight overnight peer. Reboot manually when `/var/run/reboot-required` exists and no slot is active (slot-gate it once the phase-1 scheduler exists).

Swap (absorbs Playwright + tsc co-peaks without disk wear):

```bash
apt install -y systemd-zram-generator
printf '[zram0]\nzram-size = 8192\ncompression-algorithm = zstd\n' > /etc/systemd/zram-generator.conf
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile
echo '/swapfile none swap sw,pri=1 0 0' >> /etc/fstab && swapon -a
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/90-swap.conf
```

Peer scopes keep `MemoryMax=4G` **and add `MemorySwapMax`** so a runaway test run is constrained before it drags GITS into swap.

## 3. Tailscale (do this before touching sshd)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --hostname vps-eu
```

Admin console, non-optional:

- **Disable key expiry** on this node — the 180-day default silently drops an unattended box off the tailnet (= total lockout).
- Enable **Tailnet Lock**.
- SSH ACL uses `action: "accept"`, **not** `"check"` — `check` forces periodic browser re-auth that blocks headless use:

```json
"ssh": [{ "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["ops", "root"] }]
```

## 4. OpenSSH fallback + host firewall

`/etc/ssh/sshd_config.d/90-hardening.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers ops
MaxAuthTries 3
X11Forwarding no
```

Rely on ufw to make sshd tailnet-only (avoids the ListenAddress-before-tailscaled ordering trap):

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow in on tailscale0
ufw enable
```

**Validation order (anti-lockout):** keep the SCP remote-console tab open → provider deny-all → `tailscale up --ssh` → verify Tailscale SSH in a fresh session → apply sshd + ufw → verify **both** paths again → only then close the console.

Do **not** install fail2ban (no public attack surface; only self-lockout risk) and do **not** install Docker (peers run tests on the host; Docker's iptables rules bypass ufw — if it ever lands, publish ports as `127.0.0.1:` only).

## 5. Runtime stack

```bash
# Node LTS (systemd-friendly absolute paths) + Bun
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt install -y nodejs
curl -fsSL https://bun.sh/install | bash
npm install -g @openai/codex
# Playwright system deps come with the repo's own install step (npx playwright install --with-deps)
# herdr per its docs (Rust binary): no daemon, no port; chmod 700 ~/.config/herdr
```

## 6. Codex auth homes (design decisions 19 + 21)

One dedicated home per consumer, **each authenticated on this host** via the tailnet SSH session — never copy an `auth.json` from another machine (rotating refresh tokens: two refreshers on one chain kill it with `refresh_token_reused`).

| Consumer                | Home                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Interactive codex (you) | `~/.codex`                                                                                                                 |
| Hermes/Motoko brain     | inside `HERMES_HOME` — `~/.gits/hermes/auth.json` (`HERMES_HOME=~/.gits/hermes hermes auth add openai-codex --type oauth`) |
| delamain peers          | `~/.delamain/peer-codex-home`                                                                                              |

No Claude credentials on this box (decision 19: headless Claude is metered; autonomy is all-codex). Before first armed night, run the decision-19 audit: nothing in GITS config may instantiate the Claude provider headlessly.

## 7. Repos, verify floor, services

```bash
sudo mkdir -p /srv/gits/{repos,worktrees,runtime} && sudo chown -R ops: /srv/gits
cd /srv/gits/repos
git clone git@github.com:Ecko95/gitscode.git && git clone git@github.com:Ecko95/delamain.git
git clone <isomer-calc-engine remote>
# delamain: npm ci && npm run build && npm link   (same layout the local delamain-main worktree uses)
# each repo: install deps and run its verify commands GREEN — the verification floor
# (decision 13: a repo with a red baseline is ineligible for autonomy)
```

Deploy GITS with the existing native-Linux script (installs the systemd user service and wires `tailscale serve`):

```bash
/srv/gits/repos/gitscode/scripts/gits-hosting/deploy-gits-tailnet-hosted.sh
```

## 8. Backups (3-2-1 — netcup does none contractually and disclaims data-loss liability)

- **netcup snapshots** (included, copy-on-write): take one before any risky change. Rollback layer only — they live on netcup infrastructure and are not a backup.
- **Primary: server → Backblaze B2 nightly** via restic (systemd timer; client-side encrypted). Include: `~/.gits`, `~/.delamain` (state + archive, **not** worktrees), repo-local `.planning/`, crontab, `/etc` configs. **Exclude codex `auth.json` chains** — restoring an old refresh token collides with the live chain (`refresh_token_reused`); the restore procedure is re-login per home via the console. Data volume is a few GB → pennies/month.
- **Offline mirror: local machine ← B2** whenever it is on (`rclone sync` of the encrypted repo, scheduled). The laptop _pulls_, so its downtime never gaps the primary, and a compromised server cannot reach this copy.
- **Golden image**: after phase 0 completes, one manual snapshot-export (qcow2) downloaded locally — a restore-whole-configured-server artifact, refreshed only at milestones.
- **Restore test once** after setup: restore to a temp dir and open the state files. Untested backups do not count. The server is never the only copy.

## 9. Break-glass runbook

1. Tailscale SSH fails → try plain `ssh ops@100.x.y.z` (OpenSSH over tailnet).
2. Both fail → netcup SCP remote console (passwords from vault); fix tailscaled/sshd.
3. Boot-level damage → netcup rescue system, mount + chroot.
4. Last resort only: temporary provider-firewall rule `TCP 22 from <your-current-ip>/32` — delete it the moment you're back in. Never `0.0.0.0/0`, never standing.

#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 host as the GITS/delamain autonomy server.
# Companion to docs/gits/VPS_SETUP.md — encodes the 2026-07-13 vps-eu build,
# including every gotcha hit on the first run (see step comments).
#
# Usage (as root on the NEW box):
#   scp this script over, then:  bash provision-autonomy-host.sh            # run all pending steps
#   bash provision-autonomy-host.sh --list                                  # show step status
#   bash provision-autonomy-host.sh --only <step>                           # run one step
#   bash provision-autonomy-host.sh --redo <step>                           # force-rerun one step
#
# Steps run in order and are idempotent; completed steps are recorded in
# /var/lib/gits-provision/ and skipped on rerun. Steps named human:* PAUSE
# with instructions — do the manual part, then rerun the script to continue.
# Two gates cannot be auto-verified and need explicit acknowledgement after
# you complete them:  bash provision-autonomy-host.sh --confirm <step>
#
# Pre-flight (before this script): order the server; install Ubuntu 24.04
# via the provider panel (hostname below, locale en_US.UTF-8); ssh-copy-id
# your key to root; provider firewall = TCP 22 from your current IP only.

set -euo pipefail

# ---- knobs (override via env) ------------------------------------------------
HOST_NAME="${HOST_NAME:-vps-eu}"
OPS_USER="${OPS_USER:-ops}"
TIMEZONE="${TIMEZONE:-Europe/London}"
SSH_FALLBACK_PORT="${SSH_FALLBACK_PORT:-2222}"
GITS_ROOT="${GITS_ROOT:-/srv/gits}"
# repo list: "<dir>:<ssh-alias>:<github-owner/repo>" — one write-scoped deploy key per repo
REPOS="${REPOS:-gitscode:github-gitscode:Ecko95/gitscode delamain:github-delamain:Ecko95/delamain}"
GITS_BRANCH="${GITS_BRANCH:-gits}"
PEER_MODEL="${PEER_MODEL:-gpt-5.5}"
PEER_EFFORT="${PEER_EFFORT:-high}"
# ------------------------------------------------------------------------------

STATE_DIR=/var/lib/gits-provision
mkdir -p "$STATE_DIR"
OPS_HOME="$(getent passwd "$OPS_USER" 2>/dev/null | cut -d: -f6 || true)"
[[ -n "$OPS_HOME" ]] || OPS_HOME="/home/$OPS_USER"

log()  { printf '\n\033[1;36m[provision]\033[0m %s\n' "$*"; }
pause(){ printf '\n\033[1;33m[HUMAN STEP REQUIRED]\033[0m %s\n' "$*"; exit 0; }
as_ops(){ su - "$OPS_USER" -c "$*"; }

STEPS=(base packages upgrades swap tailscale human:tailscale-admin ssh-harden ufw human:perimeter stack repos-layout deploy-keys human:register-keys clone verify gits-deploy codex-homes human:logins summary)

done_f(){ echo "$STATE_DIR/$1.done"; }
is_done(){ [[ -f "$(done_f "$1")" ]]; }
mark(){ touch "$(done_f "$1")"; }

step_base() {
	id "$OPS_USER" &>/dev/null || adduser --disabled-password --gecos "" "$OPS_USER"
	usermod -aG sudo "$OPS_USER"
	echo "$OPS_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$OPS_USER" && chmod 440 "/etc/sudoers.d/90-$OPS_USER"
	mkdir -p "$OPS_HOME/.ssh"
	[[ -f "$OPS_HOME/.ssh/authorized_keys" ]] || cp /root/.ssh/authorized_keys "$OPS_HOME/.ssh/"
	chown -R "$OPS_USER:$OPS_USER" "$OPS_HOME/.ssh"; chmod 700 "$OPS_HOME/.ssh"; chmod 600 "$OPS_HOME/.ssh/authorized_keys"
	timedatectl set-timezone "$TIMEZONE"   # installers ignore the panel TZ choice — pin explicitly
	loginctl enable-linger "$OPS_USER"
	hostnamectl set-hostname "$HOST_NAME"
}

step_packages() {
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq && apt-get full-upgrade -y -qq
	# unzip: bun installer hard-requires it; pkg-config: native module builds
	apt-get install -y -qq unattended-upgrades git tmux curl build-essential systemd-zram-generator unzip pkg-config
}

step_upgrades() {
	printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
	# Never auto-reboot: a 04:00 reboot kills in-flight overnight peers. Reboot slot-aware.
	printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/52unattended-upgrades-local
}

step_swap() {
	printf '[zram0]\nzram-size = 8192\ncompression-algorithm = zstd\n' > /etc/systemd/zram-generator.conf
	systemctl daemon-reload
	modprobe zram                    # generator silently no-ops without the module loaded
	systemctl restart systemd-zram-setup@zram0.service
	[[ -f /swapfile ]] || { fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -f /swapfile >/dev/null; }
	grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw,pri=1 0 0' >> /etc/fstab
	swapon --show | grep -q '^/swapfile' || swapon /swapfile
	# both layers must actually be active — this box's sizing depends on them
	swapon --show | grep -q zram0 || { echo "zram0 swap missing"; exit 1; }
	sysctl -w vm.swappiness=10 >/dev/null && echo 'vm.swappiness=10' > /etc/sysctl.d/90-swap.conf
}

step_tailscale() {
	command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
	if ! tailscale status &>/dev/null; then
		(nohup tailscale up --ssh --hostname "$HOST_NAME" >/tmp/ts-up.log 2>&1 &)
		sleep 6; cat /tmp/ts-up.log
	fi
}

step_human_tailscale_admin() {
	# Cannot auto-verify the ACL or an inbound login from the box itself, and the
	# runbook's anti-lockout order REQUIRES a proven tailnet SSH login before
	# sshd hardening + ufw. Explicit acknowledgement only.
	local url=""; [[ -f /tmp/ts-up.log ]] && url="$(grep -o 'https://login.tailscale.com/[a-z0-9/]*' /tmp/ts-up.log | head -1 || true)"
	pause "1) Approve this node${url:+ (auth URL: $url)}.
2) Admin console -> Machines -> $HOST_NAME -> DISABLE KEY EXPIRY (180d default strands an unattended box).
3) Access Controls: ssh rule action must be \"accept\" (NOT the default \"check\" — check demands a browser re-auth per session), users [\"$OPS_USER\"].
4) VERIFY FROM YOUR MACHINE (this is the anti-lockout gate — do not skip):
     ssh $OPS_USER@\$(tailscale ip -4 on this box)   # must land WITHOUT a browser prompt
Then acknowledge with:  bash $0 --confirm human:tailscale-admin   and rerun."
}

step_ssh_harden() {
	cat > /etc/ssh/sshd_config.d/90-hardening.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $OPS_USER
MaxAuthTries 3
X11Forwarding no
EOF
	# Ubuntu 24.04 sshd is SOCKET-ACTIVATED: Port directives in sshd_config are
	# ignored, and bare "ListenStream=port" binds v6-only in practice. Bind both
	# families explicitly. Port $SSH_FALLBACK_PORT = OpenSSH fallback over the
	# tailnet (tailscale SSH intercepts 22 on the tailnet interface).
	mkdir -p /etc/systemd/system/ssh.socket.d
	cat > /etc/systemd/system/ssh.socket.d/listen.conf <<EOF
[Socket]
ListenStream=
ListenStream=0.0.0.0:22
ListenStream=[::]:22
ListenStream=0.0.0.0:$SSH_FALLBACK_PORT
ListenStream=[::]:$SSH_FALLBACK_PORT
EOF
	sshd -t
	systemctl daemon-reload && systemctl restart ssh.socket
}

step_ufw() {
	ufw default deny incoming >/dev/null
	ufw default allow outgoing >/dev/null
	ufw allow in on tailscale0 >/dev/null
	ufw --force enable
}

step_human_perimeter() {
	pause "Verify from YOUR machine before closing the provider console tab:
  ssh $OPS_USER@<tailscale-ip>                 # tailscale SSH
  ssh -p $SSH_FALLBACK_PORT $OPS_USER@<tailscale-ip>   # OpenSSH fallback (key)
Both must work. Then set the PROVIDER firewall to deny-all inbound and confirm
the public IP is dark:  nc -vz -w5 <public-ip> 22   (must time out).
Then acknowledge with:  bash $0 --confirm human:perimeter   and rerun."
}

step_stack() {
	export DEBIAN_FRONTEND=noninteractive
	command -v node >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null; apt-get install -y -qq nodejs; }
	npm ls -g @openai/codex &>/dev/null || npm install -g @openai/codex
	npm ls -g @anthropic-ai/claude-code &>/dev/null || npm install -g @anthropic-ai/claude-code
	npm ls -g @mariozechner/pi-coding-agent &>/dev/null || npm install -g @mariozechner/pi-coding-agent
	[[ -x "$OPS_HOME/.bun/bin/bun" ]] || as_ops 'curl -fsSL https://bun.sh/install | bash'
	[[ -d "$OPS_HOME/.nvm" ]] || as_ops 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && export NVM_DIR=~/.nvm && . ~/.nvm/nvm.sh && nvm install 24'
	[[ -x "$OPS_HOME/.local/bin/cursor-agent" ]] || as_ops 'curl -fsS https://cursor.com/install | bash' || true
	[[ -x "$OPS_HOME/.local/bin/herdr" ]] || as_ops 'curl -fsSL https://herdr.dev/install.sh | sh'
	# .bashrc PATH additions never load in non-interactive shells (systemd, ssh
	# exec, turbo's package-manager lookup, herdr remote attach) — symlink.
	ln -sf "$OPS_HOME/.bun/bin/bun"  /usr/local/bin/bun
	ln -sf "$OPS_HOME/.bun/bin/bunx" /usr/local/bin/bunx
	ln -sf "$OPS_HOME/.local/bin/herdr" /usr/local/bin/herdr
	as_ops 'mkdir -m 700 -p ~/.config/herdr'
}

step_repos_layout() {
	mkdir -p "$GITS_ROOT"/{repos,worktrees,runtime}
	chown -R "$OPS_USER:$OPS_USER" "$GITS_ROOT"
}

step_deploy_keys() {
	# One write-scoped deploy key per repo — never an account-level key: a
	# compromised host must not reach beyond exactly these repos.
	for spec in $REPOS; do
		alias="${spec#*:}"; alias="${alias%%:*}"
		keyfile="$OPS_HOME/.ssh/id_ed25519_${alias#github-}"
		[[ -f "$keyfile" ]] || as_ops "ssh-keygen -t ed25519 -N '' -f $keyfile -C $HOST_NAME-${alias#github-} -q"
		if ! grep -q "^Host $alias\$" "$OPS_HOME/.ssh/config" 2>/dev/null; then
			as_ops "printf 'Host %s\n\tHostName github.com\n\tUser git\n\tIdentityFile %s\n\tIdentitiesOnly yes\n\n' '$alias' '$keyfile' >> ~/.ssh/config && chmod 600 ~/.ssh/config"
		fi
	done
}

step_human_register_keys() {
	local unregistered=0
	for spec in $REPOS; do
		alias="${spec#*:}"; alias="${alias%%:*}"; gh_repo="${spec##*:}"
		if ! as_ops "ssh -T -o StrictHostKeyChecking=accept-new git@$alias 2>&1 | grep -q 'successfully authenticated'"; then
			unregistered=1
			if [[ ! -f "$OPS_HOME/.ssh/id_ed25519_${alias#github-}.pub" ]]; then
				echo "No key generated for $alias (REPOS changed?) — run: bash $0 --redo deploy-keys"; continue
			fi
			echo; echo "Deploy key for $gh_repo (add with write access):"
			cat "$OPS_HOME/.ssh/id_ed25519_${alias#github-}.pub"
			echo "  -> repo Settings -> Deploy keys -> Add (allow write), or from an authed machine:"
			echo "     gh repo deploy-key add <pubkey-file> --repo $gh_repo --allow-write --title $HOST_NAME-${alias#github-}"
		fi
	done
	[[ $unregistered -eq 0 ]] || pause "Register the deploy key(s) above, then rerun this script."
}

step_clone() {
	for spec in $REPOS; do
		dir="${spec%%:*}"; rest="${spec#*:}"; alias="${rest%%:*}"; gh_repo="${spec##*:}"
		[[ -d "$GITS_ROOT/repos/$dir/.git" ]] || as_ops "git clone -q $alias:$gh_repo.git $GITS_ROOT/repos/$dir"
	done
	if [[ -d "$GITS_ROOT/repos/gitscode" ]]; then
		as_ops "cd $GITS_ROOT/repos/gitscode && git checkout -q $GITS_BRANCH && bun install --frozen-lockfile"
		# bun can skip/fail native postinstalls on first run (node-pty, electron).
		# Reuse CI's own electron ensure-step.
		as_ops "cd $GITS_ROOT/repos/gitscode && node -e \"require('./apps/desktop/node_modules/electron')\" 2>/dev/null || { rm -rf apps/desktop/node_modules/electron/dist apps/desktop/node_modules/electron/path.txt; bun apps/desktop/node_modules/electron/install.js; }" || true
	fi
	if [[ -d "$GITS_ROOT/repos/delamain" ]]; then
		as_ops "cd $GITS_ROOT/repos/delamain && npm ci --no-audit --no-fund && npm run build"
		(cd "$GITS_ROOT/repos/delamain" && npm link)
	fi
}

step_verify() {
	# Verification floor (off-hours design decision 13): green tests before the
	# host is eligible for autonomy. Failures here STOP provisioning on purpose.
	# pipefail inside each ops shell: without it "cmd | tail" returns tail's 0
	# and a red baseline would silently provision as green.
	if [[ -d "$GITS_ROOT/repos/delamain" ]]; then
		as_ops "set -o pipefail; cd $GITS_ROOT/repos/delamain && npm test 2>&1 | tail -3 && npx vitest run src/ 2>&1 | tail -4"
	fi
	if [[ -d "$GITS_ROOT/repos/gitscode" ]]; then
		as_ops "set -o pipefail; cd $GITS_ROOT/repos/gitscode && bun run typecheck 2>&1 | tail -3"
		# Known flake: wsTransport resubscribe test under parallel load — one retry.
		as_ops "set -o pipefail; cd $GITS_ROOT/repos/gitscode && bun run test 2>&1 | tail -3" || {
			log "gitscode tests failed once — retrying (known wsTransport flake)"
			as_ops "set -o pipefail; cd $GITS_ROOT/repos/gitscode && bun run test 2>&1 | tail -3"
		}
	fi
}

step_gits_deploy() {
	[[ -d "$GITS_ROOT/repos/gitscode" ]] || { log "no gitscode repo — skipping deploy"; return 0; }
	as_ops "export GITS_HOSTING_REPO=$GITS_ROOT/repos/gitscode GITS_HOSTING_WORKTREE=$GITS_ROOT/runtime/gits-hosted XDG_RUNTIME_DIR=/run/user/\$(id -u) && cd $GITS_ROOT/repos/gitscode && ./scripts/gits-hosting/install-gits-user-service.sh && ./scripts/gits-hosting/deploy-gits-tailnet-hosted.sh"
	GITS_HOSTING_REPO="$GITS_ROOT/repos/gitscode" bash "$GITS_ROOT/repos/gitscode/scripts/gits-hosting/configure-tailscale-serve.sh"
}

step_codex_homes() {
	# One codex home per consumer, each its own OAuth chain (design decision 21).
	# NEVER copy auth.json between homes or hosts: rotating refresh tokens make
	# a copied chain die with refresh_token_reused.
	as_ops "mkdir -m 700 -p ~/.delamain/peer-codex-home"
	if [[ ! -f "$OPS_HOME/.delamain/peer-codex-home/config.toml" ]]; then
		as_ops "cat > ~/.delamain/peer-codex-home/config.toml <<EOF
model = \"$PEER_MODEL\"
model_reasoning_effort = \"$PEER_EFFORT\"
# Peers write .git metadata of linked worktrees (outside the worktree itself).
sandbox_mode = \"danger-full-access\"
approval_policy = \"never\"

[projects.\"$OPS_HOME\"]
trust_level = \"trusted\"

[projects.\"$GITS_ROOT\"]
trust_level = \"trusted\"

[mcp_servers.delamain-peers]
command = \"node\"
args = [\"$GITS_ROOT/repos/delamain/dist/index.js\", \"server\"]
EOF"
	fi
}

step_human_logins() {
	# Required: the two codex chains (autonomy is all-codex, decision 19).
	# Claude/cursor are OPTIONAL interactive-only tools — never a completion gate,
	# and the decision-19 audit must ensure no automation instantiates them.
	local missing=""
	[[ -f "$OPS_HOME/.codex/auth.json" ]] || missing+=" codex-interactive"
	[[ -f "$OPS_HOME/.delamain/peer-codex-home/auth.json" ]] || missing+=" codex-peer-home"
	[[ -f "$OPS_HOME/.claude/.credentials.json" ]] || log "note: claude not logged in (optional, interactive-only)"
	[[ -z "$missing" ]] || pause "Codex logins still needed:$missing
From your machine (codex's OAuth callback needs the tunnel):
  ssh -L 1455:localhost:1455 -p $SSH_FALLBACK_PORT $OPS_USER@<tailscale-ip>
Then inside:  codex login
              CODEX_HOME=~/.delamain/peer-codex-home codex login
Optional interactive tools:  claude (/login), cursor-agent login
Then rerun this script."
}

step_summary() {
	log "provisioning complete — status:"
	timedatectl show -p Timezone; { swapon --show | tail -2; } || true
	{ tailscale status 2>/dev/null | head -1; } || true; { ufw status | head -2; } || true
	as_ops "delamain waves 2>/dev/null | head -3" || true
	systemctl --user -M "$OPS_USER@" status gits-cockpit.service --no-pager 2>/dev/null | head -3 || true
	tailscale serve status 2>/dev/null | head -2 || true
	log "remaining by hand: restic->B2 backups; provider-panel snapshot; login tripwire (phase 2)."
}

run_step() {
	local s="$1" fn="step_${1//[:-]/_}"
	if is_done "$s"; then log "skip $s (done)"; return 0; fi
	log "running: $s"
	"$fn"
	mark "$s"
}

case "${1:-run}" in
	run) for s in "${STEPS[@]}"; do run_step "$s"; done; log "all steps complete" ;;
	--list) for s in "${STEPS[@]}"; do printf '%-24s %s\n' "$s" "$(is_done "$s" && echo done || echo pending)"; done ;;
	--only) run_step "$2" ;;
	--redo) rm -f "$(done_f "$2")"; run_step "$2" ;;
	--confirm)
		[[ "${2:-}" == human:* ]] || { echo "--confirm is only for human:* gates"; exit 1; }
		mark "$2"; log "acknowledged $2" ;;
	--help|-h) sed -n '2,20p' "$0" ;;
	*) echo "unknown option: $1 (see --help)"; exit 1 ;;
esac

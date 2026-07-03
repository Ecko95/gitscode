# Linux Remote Dev Performance

Research from Theo's "Why I'm Moving to Linux (for real)" — benchmarks and workflow patterns relevant to inspecting gits performance.

## Why This Matters for gits

gits is the tool that enables the remote-dev workflow Theo describes. The file system and process-overhead problems he hit on macOS are exactly the bottlenecks that using gits over Tailscale on a Linux box solves. This doc captures how to measure whether your current setup is healthy.

---

## The Three Problem Areas

### 1. File System Speed (APFS vs ext4)

Theo's benchmark: `git clean` + `pnpm install` from cache on a multi-package repo.

| Setup                            | `git clean` | `pnpm install` |
| -------------------------------- | ----------- | -------------- |
| Linux (ext4, Framework desktop)  | ~2.5s       | ~7.3s          |
| macOS (APFS, M5 Max MacBook Pro) | ~20–35s     | ~35s           |

ext4 is **10–30× faster** for small-file-heavy operations — worktree creation, cache restores, PNPM installs — exactly the pattern sub-agent workflows use constantly.

### 2. CPU / Process Overhead (macOS syspolicyd)

macOS `syspolicyd` monitors every new process for security policy. Codex / Claude Code spawn **30+ processes per sub-agent** (MCP servers, connection clients, etc.). Under concurrent sub-agent workloads this pins CPU and triggers thermal throttling even on M5 Max hardware.

On Linux this process-tracking overhead doesn't exist, so multi-agent runs use a fraction of the CPU.

### 3. Remote Session UX

Theo's solution: SSH → auto-attach tmux + T3 Code (gits) served over Tailscale. This gives:

- Session persistence across disconnects
- Image paste support (blocked over plain SSH)
- Full terminal + GUI in one interface
- Works on 5G / any network via Tailscale

---

## Action Plan: Inspect Your Current Setup

### Step 1 — File System Baseline

```bash
cd ~/dev/projects/gitscode
time git clean -fdx
time pnpm install
```

**Target:** both under 10s. Over 30s = APFS bottleneck; offload to Linux box.

### Step 2 — Worktree Speed

```bash
time git worktree add /tmp/gits-bench-wt origin/gits
time pnpm install --dir /tmp/gits-bench-wt
git worktree remove /tmp/gits-bench-wt --force
```

**Target:** full add + install under 15s.

### Step 3 — CPU During Agent Work

Run btop in a split pane while a Claude Code or Codex session with sub-agents is active:

```bash
btop
```

Watch for:

- Any core sustained >50%
- `syspolicyd` appearing in top processes (macOS only — signals the process-spawn tax)

### Step 4 — Tailscale / gits Connectivity

```bash
# Latency to your remote Linux box
ping <tailscale-ip-of-remote-box>

# Serve gits and connect from another machine
npx t3@nightly serve
```

**Target:** ping < 10ms on LAN, < 30ms over Tailscale.

### Step 5 — tmux Session Persistence

Verify your remote box auto-attaches tmux on SSH:

```bash
ssh <remote-box> "tmux ls"
```

If empty, add to `~/.bashrc` on the remote:

```bash
[[ -z "$TMUX" ]] && exec tmux new-session -A -s main
```

---

## Quick Verdict Table

| Metric                  | Healthy                    | Action if failing                   |
| ----------------------- | -------------------------- | ----------------------------------- |
| `git clean` time        | < 10s                      | Move work to Linux box              |
| `pnpm install` (cold)   | < 10s                      | Move work to Linux box              |
| Worktree add + install  | < 15s                      | Move work to Linux box              |
| `syspolicyd` CPU        | < 5%                       | Move sub-agent work off Mac         |
| Tailscale ping          | < 10ms LAN / < 30ms remote | Check Tailscale exit node / routing |
| tmux sessions on remote | persistent                 | Add auto-attach to `.bashrc`        |

---

## Recommended Setup (from the video)

1. **Linux box on local network** — any machine with 16+ threads and ext4. GMK K8 Plus (~$400–740) is Theo's pick, but any old laptop/desktop works.
2. **Tailscale** — zero-config mesh VPN, handles NAT traversal for remote access.
3. **gits served on the Linux box** — `npx t3@nightly serve` on the remote, connect via Tailscale address in the gits desktop app.
4. **tmux on SSH** — auto-attach so long-running agent jobs survive disconnects.
5. **Network KVM (optional)** — GLinet KVM for full GUI access when needed (OS flashing, boot recovery). Enables Codex computer-use tasks on remote machines.

## Key Insight

The MacBook stays as the orchestrator — it has SSH keys to all boxes and the fleet skill. Heavy agent work (sub-agents, worktrees, long CI loops) runs on the Linux box via gits. The laptop's CPU never spins up; you can close the lid.

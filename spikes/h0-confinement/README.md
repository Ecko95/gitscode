# H0 Confinement Spike

Proof-of-feasibility for **H0** in `docs/gits/ORCHESTRATION_SELF_IMPROVEMENT_DESIGN.md` §Hardening:
run a peer command / verification suite under OS-level confinement so a hostile repo cannot read
operator secrets, write outside its worktree, run install-time scripts, or reach the network.

## Files

- `gits-confine.sh` — the confinement wrapper (bubblewrap). Runs a command with the worktree as the
  only writable real path, a clean ephemeral `HOME`, a scrubbed environment, `--ignore-scripts`
  forced, and network off by default.
- `run-spike.sh` — threat + usability test harness. Plants a sentinel "secret", builds a hostile
  fixture worktree (malicious npm `preinstall`), runs an unconfined control, then the confined
  checks, and prints a PASS/FAIL table. Self-cleaning.
- `SPIKE_FINDINGS.md` — results, findings, integration path, recommendation.

## Run

```bash
spikes/h0-confinement/run-spike.sh
```

Requires `bwrap` (bubblewrap) and unprivileged user namespaces. The harness needs no arguments and
cleans up after itself (removes the sentinel and the temp worktree on exit).

## Use the wrapper directly

```bash
# net off (default) — for untrusted-repo verification:
spikes/h0-confinement/gits-confine.sh --worktree /path/to/worktree -- npm test -- --run

# extra read-only toolchain binds (e.g. pnpm/bun homes):
GITS_CONFINE_EXTRA_ROBINDS="$HOME/.local/share/pnpm:$HOME/.bun" \
  spikes/h0-confinement/gits-confine.sh --worktree /path/to/wt -- pnpm test
```

> SPIKE status: not wired into delamain or the autopilot yet. See `SPIKE_FINDINGS.md` for the
> integration path (verification-under-confinement first; peer-under-confinement second).

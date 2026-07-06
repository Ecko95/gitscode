# Sandboxing

`scripts/gits-confine.sh` is the canonical OS-level confinement wrapper for GITS peer execution and verification. It implements the H0 hardening layer and requires bubblewrap (`bwrap`); if `bwrap` is unavailable, the wrapper exits instead of running unconfined.

There are two profiles:

- `verify` is the default profile for untrusted verification. It allows worktree-only writes, binds no credentials, turns network off, and disables npm lifecycle scripts.
- `peer` is for coding peers that need provider credentials and sometimes network. It binds only explicitly named credentials read-only, hides the rest of `$HOME`, and applies the selected egress policy. The default egress policy is off.

The sandbox uses Linux namespaces and hardening flags including `--unshare-user`, `--unshare-pid`, `--unshare-ipc`, `--unshare-uts`, `--unshare-cgroup`, `--unshare-net` when egress is off, `--cap-drop ALL`, `--new-session`, `--die-with-parent`, and `--clearenv`.

The filesystem jail binds `/usr` and `/etc` read-only, creates fresh `/proc` and `/dev`, mounts tmpfs for `/tmp`, `/run`, and `/sandbox-home`, and makes only the selected worktree writable.

The peer profile was verified to expose only the provided provider credentials, not operator credentials such as `~/.codex/auth.json`, `~/.gits/hermes`, `~/.gits/secrets`, Telegram credentials, or Cursor dashboard tokens. For untrusted repos, privilege-bypass flags such as Codex `--yolo`, `danger-full-access`, and Cursor `--force --trust` should be dropped.

Remaining gap: a true peer egress allowlist still needs pasta plus a CONNECT proxy or root nftables. Until that exists, `--egress proxy=` only sets proxy environment variables and is advisory.

Prerequisites are `bwrap`, unprivileged user namespaces, and `jq` for the confined verification runner. Hosts that disable unprivileged user namespaces must fail closed.

Sources: `scripts/gits-confine.sh`, `docs/gits/H0_CONFINEMENT.md`.

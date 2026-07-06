# Agent Orchestration

Delamain is the peer-execution substrate. It owns isolated worktrees, peer spawn/status/log/reply/wait/kill controls, frozen gates, and PR integration. The web client calls typed `gits.delamain.*` RPC methods; only the server adapter invokes the local `delamain` binary, and it does so with fixed argument lists.

Hermes is the runtime. Motoko is the GITS-owned operator profile running on Hermes. Motoko is observe/propose-only by default: it must not merge, admin-merge, force-push, run destructive shell commands, or use `HERMES_YOLO_MODE`. Hermes approval mode must be `manual` or `smart`; `off` is unsafe.

Motoko emits proposal cards that carry an action kind:

- `read-only`
- `worktree-spawn`
- `repo-write`
- `integrate`
- `destructive-shell`

Only read-only proposals are informational. Other action kinds require approval and remain handoff-only until the operator routes them into a Delamain, Open GSD, or verification draft. Repo writes are handed to Delamain so execution happens in isolated worktrees.

Automode is server-owned supervision. The browser reads and mutates typed automode state through `gits.automode.*`; it does not spawn autonomous peers directly. Automode enforces the kill switch, active peer limits, repo and model allowlists, approval gates, runtime limits, and budget checks. Budget checks fail closed when a USD budget is configured but provider cost telemetry is missing.

Provider capacity routing is advisory. Codex capacity is read from local rate-limit events, Cursor defaults to a monthly budget cap, and Hermes may only propose a Delamain engine. Approvals and Delamain worktree isolation still own execution.

The orchestration design is novel in composition, not in every component: prior-art research found no popular OSS repo combining worktree-isolated parallel peers, a self-improvement loop, editable/diffable orchestration config, and a human approval gate.

Sources: `docs/gits/ARCHITECTURE.md`, `docs/gits/HERMES.md`, `docs/gits/ORCHESTRATION_PRIOR_ART.md`.

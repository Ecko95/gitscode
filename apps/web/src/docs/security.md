# Security Model

The 2026-07-06 audit found the current security posture solid and did not identify an exploitable issue. The audited posture includes auth before RPC construction, CSPRNG plus HMAC and DB-backed revocable tokens, arg-array git calls with `--` guards, path traversal blocking, thread scoping at the claimed surfaces, an empty gitleaks report, and an inert CORS wildcard.

A paired `client` role effectively has full agent-execution rights because dispatches act as the operator. Treat pairing URLs and pairing tokens like passwords. Anyone with a valid pairing credential can create a session until that credential expires or is revoked, and hosted pairing URLs can still leak through browser history, screenshots, logs, or copy/paste.

Execution confinement is the foundation for trusted self-improvement. Peers and verification must run under OS-level confinement, or the trust model is void. The GITS verification gate fails closed with `GitsVerificationGateError` when confinement is unavailable and `requireConfinement` is set.

Known limits:

- Peer egress with `--egress proxy=` is advisory only today. Proxy environment variables can be bypassed until a real pasta/nftables allowlist exists. The default `--egress off` remains the correct containment setting.
- The verify profile has no seccomp or rlimits today, so a hostile verification job can still pressure the host, for example by forking aggressively.
- The verify profile currently binds `/etc` read-only, so verification output can expose readable host config files unless the bind set is narrowed.

Sources: `REMOTE.md`, `docs/audits/2026-07-06-full-audit.md`, `docs/gits/H0_CONFINEMENT.md`, `scripts/gits-confine.sh`.

# Plan 25 — Pi engine for Delamain peers: kill-switch verdict + phased plan

Status: DECIDED 2026-07-04 — operator killed the Pi engine (Phases 1–3 will not be built).
Phase 0 (wire `developer_instructions`, unhardcode effort, bounded `-c` passthrough in
Delamain) approved and executed. Sections below retained as the record of why.
Recon basis: 4-agent verified sweep (2026-07-04) over gitscode providers, delamain lifecycle,
the installed `@earendil-works/pi-coding-agent@0.80.3`, and codex-cli 0.142.5 + official docs.
Every claim below is file:line-verified or marked as an open question.

## 1. Kill-switch verdict: BUILD-MINIMAL

Build the **Delamain `pi` engine only**, tracer-bullet first, gated on an A/B against the
existing codex engine. **Defer the gitscode Pi provider entirely.** Do **Phase 0 (no Pi at
all) regardless** — it captures a large share of the stated win with zero new moving parts.

### The honest fractions

Reachable TODAY with Codex CLI config that delamain simply doesn't use yet (~40–50% of the
brief's stated win):

- **Subscription billing headless** — officially supported (`codex exec` with ChatGPT-managed
  auth is documented for CI/CD). Delamain peers already run on it. NOT a Pi differentiator.
- **Per-peer role prompts** — `-c developer_instructions="..."` or `-p <profile>` per spawn.
  Delamain passes neither today (verified: no AGENTS.md handling, no `-c` passthrough).
- **Model/effort per peer** — model is wired; reasoning effort is HARDCODED to `high`
  (`runner.ts:274-276`, duplicated `gsdRunner.ts:266-268`), not caller-configurable.
- **Token usage** — `codex exec --json` emits `turn.completed.usage` natively.
- **Context knobs (partial)** — `model_auto_compact_token_limit`, `compact_prompt`,
  `history.max_bytes`, `tool_output_token_limit` are all real config keys.

Genuinely Pi-only (the remainder — concentrated exactly where the brief suspected,
deliverable #4):

- **Replace the base system prompt.** Codex's compiled harness prompt is 2.7–5k tokens
  (five `instructions_template` strings measured in the binary, 10.6–19.9 KB) and is
  append-only — no config key replaces it. Pi: `--system-prompt` replaces it outright.
- **Own the tool set.** Codex core tools (shell, apply_patch, plan) cannot be pruned;
  Pi: `--tools`, `--no-builtin-tools`, extension `registerTool`.
- **Structured blocked-signal.** Codex has `default_mode_request_user_input` in the binary
  but it is disabled/"under development" — the sentinel regex is the only shipped option.
  Pi: a registered tool gives a structured, unfakeable protocol today. NOTE: OpenAI is
  visibly building this — the moat may erode within months.
- **Context-policy ownership** (the algorithm, not just thresholds).

### Performance honesty (the user's core question)

There is **no evidence** codex-model-in-Pi *outperforms* codex CLI on task quality, and a
real risk it underperforms: the model is RL-tuned with its harness prompt + apply_patch
tool shapes. The defensible claims are **adaptability** (tool/prompt/protocol ownership) and
**supervision reliability** (structured WAITING replaces the fragile sentinel — a documented
delamain pain point: peers that hang or never emit WAITING). Cost is a wash (subscription
either way). Hence: tracer + A/B gate before any deepening. If the A/B shows quality
regression, keep Phase 0 and stop — that outcome still pays for the investigation.

## 2. Premise corrections from recon (design against these, not the brief)

1. **`OPENAI_API_KEY` invariant is moot.** Pi's `openai-codex` provider is structurally
   OAuth-only (`pi-ai/dist/providers/openai-codex.js` — no `apiKey` auth path exists; the
   resolver never consults the env var for this provider). A Pi peer *cannot* silently bill
   the API. No scrubbing machinery needed.
2. **Upstream hooks are misnamed.** No `#402` reference or `@earendil-works` string exists
   anywhere in this fork (~600 branches checked). Real prior art: **~8.4k lines of abandoned
   Pi provider work** (6 commits, May 2026, author Ben Davis) on
   `remotes/origin/t3code/summarize-unstaged-changes` — SDK-hosted in-process (mirrors the
   Claude driver shape, NOT stdio-RPC), under the old package name `@mariozechner/pi-coding-agent`.
   Plus IgorWarzocha/t3code#1 upstream: an RPC-mode reference (50 files, +5,174). Two cribs
   for the deferred provider half.
3. **Delamain has no worktree cleanup/retirement** (accumulates indefinitely) and **no
   AGENTS.md handling**. The inactivity-reap in memory belongs to gitscode, not delamain.
4. **`send_peer_reply` is not a live pipe.** It spawns a new runner + new CLI process using
   native resume (`codex exec resume <threadId>`). Pi maps 1:1: `--session-id <id>` re-spawn.
5. **Codex spawn env is unscrubbed** (`env: { ...process.env, CODEX_HOME }`) — fine for Pi
   per (1), but worth knowing.
6. **Engine seam is if/else, not an interface.** `PeerEngine = 'codex'|'cursor'`
   (`types.ts:24`), two dispatch points (`runner.ts:31`, `peerManager.ts:~392`). A third
   engine touches 7 files + 2 new ones. Dashboard, killPeer, and integrate/PR paths are
   engine-agnostic. GSD phase-batch is codex-only (out of scope for pi).
7. **Pi surface verified:** `--mode json`/`--mode rpc` (28 RPC commands), per-turn
   `usage {tokens, cost}` on message events + `get_session_stats` (tokens, dollar cost,
   contextUsage), `--system-prompt`/`--append-system-prompt`, `--tools`/`--no-builtin-tools`/
   `--exclude-tools`, `-e <path>` explicit extension load (works with `--no-extensions`),
   `--session-dir` + `PI_CODING_AGENT_SESSION_DIR`, `--continue`/`--resume`/`--session-id`,
   headless modes skip trust prompts. Default tools: read, bash, edit, write (grep/find/ls
   ship but are off by default).

## 3. Open questions → recommended defaults

| # | Question | Default |
|---|----------|---------|
| 1 | Pi peer auth isolation — Pi has no home-dir env override (only session-dir) | Spawn with `HOME=~/.delamain/peer-pi-home` so `~/.pi/agent/auth.json` resolves inside it (mirrors `CODEX_HOME` pattern). One-time `pi` login there; preflight check mirroring `codexAuth.ts`. Keeps peer refreshes from clobbering the operator's daily interactive Pi. |
| 2 | Refresh-token race between concurrent pi peers (same single-use-token physics as the known codex-peer hazard, handoff pickup 3) | Cap pi-peer concurrency at 1 for the tracer; observe. Durable fix rides with the pickup-3 operator decision — do not fork a second auth strategy here. |
| 3 | One-shot `--mode json` per turn vs long-lived RPC process | One-shot + `--session-id` resume — exact mirror of delamain's existing process model, smallest diff. RPC only if mid-turn steering is later wanted. |
| 4 | Prompt delivery (stdin vs positional) | Verify at build time; either matches an existing engine's pattern (codex=stdin, cursor=positional). |
| 5 | WAITING protocol | Extension tool `report_status` (see §6); keep the sentinel regex as fallback parser (belt + braces, zero extra cost — `parseWaitingQuestion` is already shared). |
| 6 | Model for pi peers | Same as caller passes today, mapped to `--provider openai-codex --model <id>`; default `gpt-5.5` (matches operator's own Pi settings). Thinking level via `--model id:level` shorthand. |
| 7 | gitscode Pi provider now? | Defer (Phase 3). Trigger: actually wanting Pi interactive in the GITS picker. Decision doc then: resurrect the 8.4k prior art (SDK/in-process) vs mirror the RPC reference PR. |

## 4. Architecture (the `pi` engine, minimal)

```
spawn_peer(engine:'pi')
  └─ peerManager.spawnRunner → detached runner (unchanged plumbing)
       └─ piRunner.ts: spawn("pi", ["--mode","json","--session-dir",<peer sessions>,
             "--system-prompt",<role file>, "-e",<delamain extension>, ...tools flags], {
             cwd: worktree, env: { ...process.env, HOME: PEER_PI_HOME } })
          prompt → (stdin or positional, per open q4)
          stdout JSONL → append verbatim to peer.logPath (existing convention)
                       → piEvents.ts parses: session id → PeerRecord.threadId,
                         message/agent events → lastEvent + heartbeat,
                         tool_execution(report_status) → status waiting/done + question,
                         usage on message_end → token fields
  reply: resumePeer → new runner → pi --mode json --session-id <threadId> (reply as prompt)
  merge-back: pushPeerBranch / integrate_peer — UNTOUCHED (engine-agnostic)
  kill: populate enginePid — killPeer already handles it
```

Files touched (mirrors the cursor footprint exactly): `types.ts` (widen union),
`runner.ts` (dispatch), `cli.ts`, `mcpServer.ts` (schemas), `peerManager.ts` (spawn args);
new: `piRunner.ts`, `piEvents.ts`, `extensions/delamain-peer.ts`, `roles/*.md`.
Not touched: dashboard, peerIntegration, git.ts, store.ts.

## 5. Phased plan (each slice independently shippable, gated)

**Phase 0 — exploit unused Codex CLI surface (no Pi; delamain repo; ~1 day)**
Add per-peer `developer_instructions` (role prompt), unhardcode `model_reasoning_effort`,
optional bounded `-c` passthrough. GSD path gets the same effort fix.
*Gate:* spawn a codex peer with a role prompt; verify it appears in the session; existing
`npm run check` + `npm test` green. **Do this even if everything else is killed.**

**Phase 1 — tracer bullet: minimal `pi` engine (delamain repo)**
`piRunner.ts` + `piEvents.ts` + union widening, sentinel WAITING only (no extension yet),
peer-pi-home auth + preflight.
*Gate:* one pi peer completes a real trivial task end-to-end — worktree → subscription-billed
turns (openai-codex provider; architecturally $0 API) → branch pushed → integrate_peer PR.
Resume round-trip (`send_peer_reply`) works. Usage tokens visible in peer log.

**Phase 2 — A/B + the actual payoff (extension)**
(a) Same non-trivial task to a codex peer and a pi peer; compare completion quality,
wall-clock, tokens. (b) Ship `delamain-peer.ts` extension: `report_status` tool + role
system prompts (<1k tokens) + per-role toolsets.
*Gate:* forced-blocked task yields structured WAITING 5/5 runs (sentinel baseline for
comparison); reviewer-role peer (`--tools read,bash`… no write/edit) demonstrably cannot
mutate files; two concurrent pi peers complete without auth failure (or the race is
documented and concurrency stays capped).
**Kill criterion:** if (a) shows meaningful quality regression vs codex CLI, stop here;
keep Phase 0 + write the finding down.

**Phase 3 — gitscode Pi provider (DEFERRED, separate value stream)**
Sizing by precedent: OpenCode = 52 files/+4,727; abandoned Pi art = ~8.4k. Only on trigger
(see open q7). Starts with its own decision doc, not code.

## 6. Delamain Pi extension design (the genuinely-Pi-only payload)

One file, `extensions/delamain-peer.ts`, loaded per spawn with `-e` (+ `--no-extensions` to
exclude the operator's personal extensions from peers):

- **`report_status` tool** — `{ state: 'blocked'|'done', question?: string, summary?: string }`.
  The system prompt instructs the peer to call it instead of printing sentinels. The
  `--mode json` stream carries the tool call as a structured `tool_execution_*` event;
  `piEvents.ts` maps `blocked`→`status:waiting` + question, `done`→completion summary.
  Unfakeable-by-formatting, no regex, no 1000-char truncation heuristics.
- **Role presets** — spawn option `role: 'implementer'|'reviewer'|'docs'` selects
  `roles/<role>.md` (each <1k tokens) via `--system-prompt` + a toolset:
  implementer = read/bash/edit/write; reviewer = read/bash (+grep/find enabled);
  docs = read/edit/write, no bash. This is the per-peer tunability the whole effort is for.
- **Context policy** — rely on Pi's default auto-compaction initially (ponytail: don't tune
  what isn't measured); revisit only when a peer actually hits window limits.
- **Deferred ideas** (do not build now): `ask_supervisor` mid-turn Q&A over RPC mode;
  subagent/parallelism hooks; per-peer `models.json`.

## 7. Post-verdict reflections — Teleport "Pi Coding Agent" video (youtu.be/cIZpaWpI-NQ)

Watched after the verdict; it independently corroborates the recon and adds two angles:

- **Numbers confirmed from a second source**: ~1k-token system prompt + tool defs vs
  "5,000–15,000 before you've typed anything"; 4 core tools; 4 modes; extensions as
  TypeScript modules; `models.json` endpoint override. The brief's facts were sound.
- **The video's own closing is this plan's verdict**: "If Claude Code or Codex out of the
  box work for you, stay there… Pi is for engineers who want to own their tooling." We
  chose to own the *knobs* (Phase 0) and not the *harness* — same segmentation.
- **Unpriced cost surfaced**: Pi ships **no permission system at all** by design — full
  yolo, with isolation delegated to VMs/containers (Gondolin, docker, Beams). A Pi engine
  would have had *zero* native sandbox modes (codex peers at least have `--sandbox`);
  delamain worktrees are not a sandbox (plan 24's own admission). One more hidden cost of
  the killed engine that the recon didn't even get to.
- **Self-modifying harness (+`/reload`) is an interactive wow, a headless anti-feature** —
  fleet peers must run pinned `-e` extensions with `--no-extensions`, precisely to stop the
  harness drifting under supervision. The demo's appeal doesn't transfer to delamain.
- **Beams pattern = plan 24 §5's future tier, industry-validated**: disposable runtime,
  identity/RBAC/audit around a full-permission agent, and credentials injected at the
  network layer (placeholder keys in-env, real creds outside the runtime) — same shape as
  gitscode's provider child-env allowlist + revocable tokens. If the threat model ever
  escalates, this is the pattern to copy, not per-tool permission gates.
- **Session trees** (branching JSONL, parent IDs, `/export` HTML) is Pi's one genuinely
  novel feature vs codex/claude — worth remembering for peer forensics; not load-bearing.
- Discount: sponsored content for Teleport Beams.

## 8. Failure modes & rollback

- **OAuth expiry/failure mid-run:** preflight on peer-pi-home (mirror `codexAuth.ts`
  signature-mapping → actionable re-login message). Mid-run failure surfaces as
  `status:'failed'` with the auth error in the log — same as codex today.
- **Refresh race:** isolated peer-pi-home removes user-vs-peer collision; peer-vs-peer
  remains → concurrency cap (open q2), shared durable fix with pickup 3.
- **Peer never reports / hangs:** heartbeat→frozen reconciliation is engine-agnostic and
  unchanged; `report_status` strictly improves on the sentinel, never worse.
- **Stream desync / malformed JSON:** parser tolerant per-line (as codexEvents is); raw
  lines always land in peer.logPath regardless.
- **Worktree/merge conflict:** unchanged engine-agnostic path (throws → `status:'failed'`).
- **Pi version churn (0.80.x moves fast):** preflight records `pi --version`; warn on
  major/minor jump; pin known-good in docs.
- **Rollback:** the engine is additive. Stop passing `engine:'pi'`; codex/cursor paths are
  untouched by construction (dispatch-point diffs only).

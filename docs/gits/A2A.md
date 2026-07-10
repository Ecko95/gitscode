# Agent-to-Agent Messaging in GITS

A2A is how GITS-managed agents send each other messages, spanning two structurally different delivery tiers and a policy layer that gates who may send what.

## Two-Tier Vocabulary

GITS talks to agents through two structurally different channels, and A2A design must keep them distinct rather than pretend one API covers both.

- `full-injection`: GITS drives a provider protocol-level, mid-session, through ACP or the codex app-server. This is the same rigor as the [ARCHITECTURE.md](./ARCHITECTURE.md) Adapter Rule — typed adapters, fixed argument lists, no arbitrary shell — and it can interrupt a running turn.
- `mailbox / turn-boundary`: delamain headless peers only expose a command surface (spawn/status/log/reply/wait/kill/integrate, see [PARALLELISM.md](./PARALLELISM.md) Mode A). A message queues in the receiver's inbox and is delivered only when the receiver's own runner reaches a turn boundary (waiting, idle, or done) and resumes it — nothing pushes into a running peer mid-task.

Traycer's own `canParticipateInA2A` gate excludes codex and cursor TUI sessions from full-injection A2A, which is why mailbox/turn-boundary is not a fallback for headless engines — it is the only viable pattern for them.

## Traycer Research Verdicts

Research into Traycer's own A2A implementation (`~/dev/projects/traycer`) grounded the envelope and delivery design instead of inventing one from scratch.

- The Traycer A2A clients and protocol package are Apache-2.0; the Traycer host application that drives them is closed source.
- `canParticipateInA2A` excludes codex and cursor TUI sessions from Traycer's own protocol-level A2A, confirming headless engines need the mailbox tier, not full-injection.
- The message envelope is ported from Traycer's schema family (`sendAgentMessageRequestSchema` / `agentInboxMessageSchema` / a reply discriminated union), carrying `expectReply` and a minted `responseId` that a reply echoes to close the thread; the message body itself stays freeform prose, not a structured payload.
- Traycer's data model for cross-provider context replay is per-provider session anchors plus a `coveredUntilMessageId` watermark — this is the target model for R5, not something implemented yet.

## Revised Recommendations R2–R5

The Traycer re-evaluation produced four recommendations. R2 and R4 are shipped in delamain; R3 is this session's GITS work; R5 is next. There is no R1 to cite — only R2 through R5 are defined.

- `R2` — peer-to-peer mailbox messaging with turn-boundary delivery. **SHIPPED** in delamain: the MCP tools `send_peer_message` and `read_peer_inbox`, the CLI subcommands `delamain send` and `delamain inbox`, and delivery through the existing `resumePeer()` at a receiver's turn boundary.
- `R4` — the Traycer-ported envelope. **SHIPPED** in delamain alongside R2: `expectReply`/`responseId` threading and inactivity-notice reasons on the same inbox records R2 delivers.
- `R3` — GITS surfacing of that inbox plus policy gating and Motoko authority tiers. **THIS session**, read-only-first per the Automation Order rule.
- `R5` — cross-provider context replay using per-provider session anchors and `coveredUntilMessageId`. **NEXT**, out of scope this session.

## R3: GITS Surfacing and Policy Gating

R3 extends the existing typed Delamain adapter and the automode policy table rather than adding a parallel messaging subsystem.

The observe path reads a peer's inbox: `packages/contracts/src/gits.ts` adds the `DelamainMessage`/`DelamainInboxResult` schemas; `DelamainAdapter.readInbox` in `apps/server/src/gits/Services/DelamainAdapter.ts` is implemented by `apps/server/src/gits/Layers/DelamainCliAdapter.ts` (`readInbox`, wrapping `delamain inbox`); the RPC method is `gits.delamain.messages.inbox`, wired in `apps/server/src/ws.ts` as `WS_METHODS.gitsDelamainReadInbox` straight onto `delamainAdapter.readInbox`. This is a plain read, not policy-gated.

The control path is a gated send, and it does not call the adapter directly. `packages/contracts/src/gits.ts` adds `motokoAuthority: MotokoAuthority` (`Schema.Literals(["observe", "respond", "dispatch"])`) to `AutomodePolicy`, defaulted to `"observe"` in `AutomodeSupervisor`'s `defaultPolicy()` and merged in `applyPolicyUpdate()`. The RPC method `gits.delamain.messages.send` (`WS_METHODS.gitsDelamainSendMessage`) routes in `ws.ts` to `automodeSupervisor.sendPeerMessage(input)`, never to `delamainAdapter.sendMessage` — the ws.ts handler carries a comment to that effect. `AutomodeSupervisor.sendPeerMessage` applies two checks in order:

1. The `motokoAuthority` tier: `observe` blocks all sends; `respond` allows only replies (a send carrying a `responseId`); `dispatch` allows new sends.
2. The shared `evaluatePolicyGate(policy, args)` helper in `AutomodeSupervisor.ts` — the same function `dispatchGoal` already used for autonomous peer spawning, now also called with `kind: "send"`. It checks the kill switch, manual mode, repo/model allowlists, and budget, and flags integrate/merge/destructive-shell-shaped content as needing human approval. One helper, both callers — no third, ungated path was added for sends.

Authority is a policy-table value, not an identity: `motokoAuthority` lives on `AutomodePolicy` next to `mode`, `killSwitchEnabled`, and the allowlists, rather than being a special case keyed off "is this sender Motoko". Motoko sends through the same `sendPeerMessage` broker path as any other peer and is subject to the identical tier check and `evaluatePolicyGate` call — there is no separate Motoko-only send route. `integrate`, `merge`, and `destructive-shell`-shaped content stays human-gated regardless of tier — no authority level grants those automatically.

Today, Motoko's policy lives elsewhere and is stricter by default: per [HERMES.md](./HERMES.md), Motoko is a Hermes operator persona with its own `gits.hermes.*` namespace and a hardcoded `observe-propose-only` policy, disjoint from `AutomodePolicy`. This design is what brings Motoko's send authority into the automode policy table — `AutomodePolicy.motokoAuthority` does not yet exist as Motoko's live policy source; R3 is the change that makes it one.

**Known gap:** the pre-existing manual peer-action handlers — `gitsDelamainSpawnPeer`, `gitsDelamainSendPeerReply`, `gitsDelamainKillPeer`, `gitsDelamainIntegratePeer` in `ws.ts` — call the Delamain adapter directly with no policy check, predating R3. R3 closes this gap for the new send path only; the older manual handlers remain ungated and closing them is follow-up work, not silently left unmentioned.

Sources: `packages/contracts/src/gits.ts`, `apps/server/src/gits/Services/DelamainAdapter.ts`, `apps/server/src/gits/Layers/DelamainCliAdapter.ts`, `apps/server/src/gits/Layers/AutomodeSupervisor.ts`, `apps/server/src/ws.ts`, [ARCHITECTURE.md](./ARCHITECTURE.md).

## R3 Staging: Observe Before Control

The Automation Order rule in [ARCHITECTURE.md](./ARCHITECTURE.md) — observable state first, control second, automation last — applies inside R3 itself, not just across GITS milestones. Phase 1 lands `readInbox` and a read-only cockpit render of a selected peer's inbox messages, with no send controls, and must be green (typecheck, test, lint) before Phase 2 starts. Phase 2 then adds `motokoAuthority` to the policy table and the gated `sendMessage` path. A cockpit send control, if added, must call the gated path, never the adapter directly, matching the honesty requirement about the ungated manual-action gap above.

## R5: Cross-Provider Context Replay (Next)

R5 is not implemented this session. The target design, carried over from the Traycer verdicts, is a per-provider session-anchor union combined with a `coveredUntilMessageId` watermark per anchor, plus a GITS-side seed renderer that turns that union into replayable context for a resumed or forked session. This is the same anchor-and-watermark shape [PARALLELISM.md](./PARALLELISM.md) already uses for provider seeding on thread forks, extended to cover cross-provider replay of A2A message history rather than just a single thread's prefix.

Sources: `.planning/a2a-r3-handoff.md`, [ARCHITECTURE.md](./ARCHITECTURE.md), [PARALLELISM.md](./PARALLELISM.md).

# Chat Powerups Design

**Date:** 2026-07-15  
**Status:** Approved design handoff  
**Target branch:** `feat/chat-powerups` from `gits`

## Goal

Make GITS chat behave like a strong interactive agent CLI by adding provider-generated follow-up suggestions, thread-local sent-message history, an editable queue with immediate steering, selected-provider capacity in the chat header, Codex `/goal`, and a provider-neutral Ultra/Ultracode execution mode.

The implementation must reuse the existing composer draft queue, provider adapter contracts, provider rate-limit events, GITS usage readers, and provider option machinery. Pi is not part of this work.

## Scope and delivery order

This is one product direction but three implementation slices. Each slice must be independently usable and verified before starting the next.

1. **Composer powerups:** history, queue editor, Send now, and follow-up suggestions.
2. **Provider capacity header:** Codex/Claude rate-limit windows and Cursor budget usage.
3. **Agent workflows:** Codex `/goal` and provider-neutral Ultra/Ultracode mode.

Do not couple slice 1 or 2 to the workflow implementation.

## Existing foundations to reuse

- `apps/web/src/composerDraftStore.ts` already persists queued messages per scoped thread.
- `apps/web/src/components/ChatView.tsx` already enqueues and automatically dispatches messages when a turn settles.
- `apps/web/src/components/chat/ChatComposer.tsx` and `ComposerPromptEditor.tsx` own composer UI and keyboard handling.
- `apps/server/src/provider/Services/ProviderAdapter.ts` is the shared provider session boundary.
- `account.rate-limits.updated` already normalizes live account limits from Codex and Claude.
- `apps/server/src/gits/Layers/GitsUsageReader.ts` already parses Codex 5-hour and weekly windows.
- `apps/server/src/gits/Layers/GitsCapacityMonitor.ts` already reads Cursor budget telemetry.
- Provider model option descriptors already carry provider-specific model/reasoning controls to the composer.

## Slice 1: Composer powerups

### Sent-message history

- History is scoped to the current environment and thread.
- Record a message when GITS accepts it for immediate send or queueing. Do not record empty submissions or duplicate an entry merely because an automatic queue dispatch retries.
- Persist a bounded list in the existing composer draft store. Keep the newest 100 messages per thread; discard the oldest beyond that bound.
- When the composer is empty, `ArrowUp` selects the newest history entry and repeated Up/Down cycles through older/newer entries.
- Once history navigation starts, preserve the text that was in the composer and restore it when the user moves past the newest history entry.
- Do not intercept Up/Down when the editor contains a multiline selection or the caret should move within multiline text.
- Selecting history only changes the draft; it never sends automatically.

### Editable queued messages

- Replace the current queue-count-only presentation with compact rows above the composer.
- Each row shows a one-line preview, attachment count when nonzero, and actions: **Edit**, **Send now**, and **Remove**.
- Editing loads the queued message into the composer and removes that queue entry atomically. Its attachments and provider/runtime selections must be restored with the draft.
- Removing a queued message also removes any attachment references owned only by that queue entry through the existing attachment cleanup path.
- Queue order remains FIFO. Editing and resubmitting adds the message to the tail.
- Failed automatic dispatch remains visible and does not retry in a tight loop; preserve the existing failure behavior.

### Normal Send and Send now

- While no turn is active, normal Send starts a turn as it does today.
- While a turn is active, normal Send adds a durable queued message.
- **Send now** sends the selected queued message as a steering instruction to the active turn without interrupting it. It removes the entry only after the provider accepts the steering request; failure leaves the entry editable in the queue.
- Expose steering as a provider adapter capability. Providers that cannot steer disable Send now with a concise explanation; do not emulate steering by cancelling the active turn.
- A keyboard shortcut may call Send now only after the button flow works and is discoverable. Do not invent a new global shortcut if an existing agent-CLI convention is already registered in GITS.

### Provider-generated follow-up suggestions

- After a successful assistant turn settles, request exactly three concise follow-up prompts from the same selected provider instance.
- Suggestions must be generated out-of-band through the provider's text-generation service using a bounded transcript summary/current turn. They must not create a visible user turn, mutate the provider conversation, or affect rollback counts.
- The structured response is an array of one to three nonempty strings. Trim, deduplicate, cap each suggestion at 160 characters, and discard malformed output.
- Suggestions appear as compact chips above the composer. Clicking a chip fills the composer for editing and never sends automatically.
- Hide stale suggestions as soon as the user submits another message, changes provider, rolls back, or changes thread.
- Suggestion failure is silent apart from debug logging. It must not mark the completed turn failed or show a blocking toast.
- Do not generate suggestions while another turn is active, for cancelled/failed turns, or when the provider has no text-generation capability.
- Add a clearly labelled user setting because each generation consumes provider capacity. Default automatic suggestions on; users can disable them globally.

## Slice 2: Selected-provider capacity header

### Presentation

- Add a compact capacity control in `ChatHeader` for the currently selected provider instance, not merely the driver kind.
- Codex and Claude show their available short and weekly windows, for example `5h 38% used · Week 61% used`, with reset time in a tooltip/details popover.
- Cursor shows current configured budget consumption and remaining headroom. Display the source period supplied by Cursor rather than relabelling it as weekly.
- Prefer used percentage in the primary label, with remaining percentage in details, so all providers read consistently.
- Use semantic warning/critical colours already used by the capacity monitor. Do not add a chart library.
- On narrow screens collapse to the most constrained window/budget and expose the full values in the popover.

### Data and freshness

- Reuse live `account.rate-limits.updated` state for active Codex and Claude sessions.
- Seed/fallback from the existing GITS usage reader where live events have not arrived.
- Reuse Cursor capacity-monitor telemetry; move shared reading logic only if required to avoid duplication.
- Key cached capacity by provider instance. Switching the composer provider must switch the header immediately and must not leak another instance's values.
- Include `checkedAt`/reset metadata and mark data stale after the existing monitor refresh tolerance. Render `Usage unavailable` or `Stale` honestly; never estimate missing limits.
- Usage failure must not affect provider availability or sending messages.

## Slice 3: `/goal` and Ultra/Ultracode

### Codex `/goal`

- Add `/goal <objective>` to the composer command inventory when the selected provider is Codex and the installed app-server advertises goal support.
- Submitting it creates a persistent Codex goal using the native goal lifecycle rather than injecting `/goal` as ordinary prompt text.
- Surface active goal objective, status, elapsed time, and budget/usage when supplied by Codex in a compact thread status panel.
- Continue normal user turns against the active goal. Mark it complete only from the native completion event/result; do not infer completion from assistant prose.
- Allow the user to stop or replace a goal only through explicit confirmation when doing so would discard active progress.
- For unsupported Codex versions and non-Codex providers, hide the command from discovery and return a clear validation message if invoked from pasted text.
- Do not reuse GITS Automode goals: they have different ownership, persistence, and execution semantics.

### Ultra/Ultracode execution mode

- Add an `Ultra` interaction/workflow choice beside the existing Plan/Build controls for any message, persisted per scoped thread.
- For Codex, map Ultra to native subagent/Ultra workflow support when advertised. It is distinct from `xhigh` and `max` reasoning effort.
- For Claude, map it only to a confirmed native multi-agent/Ultracode capability. If the installed SDK/CLI does not expose that capability, disable the option rather than simulating it with prompt text.
- Cursor and other unsupported providers show the mode disabled with an explanation.
- Capability discovery belongs in provider snapshots/options; the web client must not hard-code version guesses.
- A message records the workflow selection used for that turn so resuming or viewing history remains intelligible.

### Ultracode animation

- When `ultracode` is typed as a recognized command/trigger or Ultra is selected, animate the visible word once with an electric gradient sweep, slight sequential letter lift, and soft glow, then settle to normal text.
- Keep the effect under one second and do not loop it while the mode remains selected.
- Implement with CSS and the existing editor/chip rendering; add no animation dependency.
- Under `prefers-reduced-motion: reduce`, skip movement and show only a brief colour emphasis or no animation.
- The animation is decorative: accessible name, focus, cursor position, and submitted text remain unchanged.

## Contracts and state

Prefer extending existing shapes over adding parallel services:

- Composer persisted state: bounded sent history and existing queued message updates.
- Provider adapter capability: whether active-turn steering is supported.
- Provider events/state: account capacity keyed by provider instance.
- Provider snapshot/options: native goal and Ultra capability advertisement.
- Orchestration turn metadata: workflow mode only if the existing interaction-mode field cannot represent it without ambiguity.

Any persisted schema change needs a decoding default and migration/normalization test so existing browser state and older server payloads continue to load.

## Error handling and reliability

- Queue mutation must be atomic from the user's perspective: never lose a message because steering or attachment restoration failed.
- Follow-up generation is best-effort and isolated from the primary turn lifecycle.
- Capacity is advisory and stale-aware; it never blocks a send.
- Goal and Ultra actions fail closed when provider capability is absent.
- Session restart/reconnect must reconstruct queued messages, history, selected workflow, active native goal state when resumable, and latest known capacity without duplicating turns.

## Testing

Add the smallest focused checks that cover each nontrivial behavior:

- Draft-store tests for bounded thread-local history, queue edit/remove, persistence, and migration defaults.
- Composer keyboard tests for empty-editor history navigation and multiline non-interference.
- ChatView tests for FIFO queueing, edit-to-draft, accepted steering removal, failed steering retention, and suggestion invalidation.
- Suggestion parser/generator tests for malformed structured output, deduplication, length cap, and provider switching.
- Header tests for provider-instance switching, stale/unavailable states, responsive summary selection, and Cursor budget wording.
- Adapter/contract tests for steering capability and native goal/Ultra capability gating.
- Reduced-motion browser/component check for the Ultracode animation.

Before completion, run the repository-required checks:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Run `bun lint:mobile` only if native mobile code changes.

## Non-goals

- Replacing Cursor ACP with Pi or `pi-cursor-sdk`.
- Building a generic workflow engine.
- Simulating unavailable provider capabilities with hidden prompts.
- Cross-thread or cross-project prompt history.
- Automatically sending a clicked suggestion.
- Cancelling an active turn as an imitation of steering.
- New chart, animation, queue, or state-management dependencies.

## Implementation handoff

Create `feat/chat-powerups` from the latest `gits` branch in a new worktree. Re-read the touched flows after branching because this repository changes quickly. Use `superpowers:writing-plans` to create executable plans per slice, then implement slice 1 first. Keep commits slice-scoped so composer improvements can land without waiting for provider workflow support.

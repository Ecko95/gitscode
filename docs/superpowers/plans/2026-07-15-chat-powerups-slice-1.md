# Chat Powerups Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add thread-local sent history, editable queued messages with steering, and provider-generated follow-up suggestions.

**Architecture:** Extend the existing persisted composer store for history and atomic queue edits. Route steering and suggestion generation through existing provider and text-generation boundaries, then keep UI orchestration in `ChatView` and presentation in small composer components.

**Tech Stack:** TypeScript, React, Zustand persistence, Effect Schema/services, Vitest.

## Global Constraints

- Keep newest 100 history entries per scoped thread.
- Reuse the existing queue, attachment cleanup, provider adapter, and text-generation machinery.
- Do not add dependencies or create visible turns for suggestions.
- Steering removes a queue entry only after provider acceptance; failures retain it.
- Suggestions default on and are invalidated on submit, provider change, rollback, or thread change.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion.

---

### Task 1: Persisted sent-message history

**Files:**

- Modify: `apps/web/src/composerDraftStore.ts`
- Test: `apps/web/src/composerDraftStore.test.ts`

**Interfaces:**

- Produces: `sentMessageHistoryByThreadKey`, `recordSentMessage(threadRef, text)`, and `getSentMessageHistory(threadRef)`.

- [ ] **Step 1: Write failing store tests**

Add tests that record nonempty accepted prompts, preserve thread/environment isolation, trim to the newest 100 entries, and normalize old persisted state to an empty history map.

- [ ] **Step 2: Verify the tests fail**

Run: `bun run --cwd apps/web test composerDraftStore.test.ts`
Expected: FAIL because the history state and actions do not exist.

- [ ] **Step 3: Implement minimal persisted history**

Add a `Schema.Record(Schema.String, Schema.Array(Schema.String))`, normalize missing state to `{}`, append `text.trim()` with `slice(-100)`, and include the map in cleanup/persistence paths.

- [ ] **Step 4: Verify and commit**

Run: `bun run --cwd apps/web test composerDraftStore.test.ts`
Expected: PASS.

Commit: `feat(web): persist composer message history`

### Task 2: Composer history keyboard navigation

**Files:**

- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Test: `apps/web/src/composer-logic.test.ts`

**Interfaces:**

- Consumes: `getSentMessageHistory` from Task 1.
- Produces: pure history-navigation helpers used by `ChatComposer` key handling.

- [ ] **Step 1: Write failing navigation tests**

Cover newest-first Up navigation, Down navigation back to the preserved draft, empty history, and refusal to intercept when multiline caret/selection movement is possible.

- [ ] **Step 2: Verify failure**

Run: `bun run --cwd apps/web test composer-logic.test.ts`
Expected: FAIL because the helper is absent.

- [ ] **Step 3: Add the smallest navigation state and key handler**

Keep `{ index, preservedDraft }` in `ChatComposer`, reset it on ordinary edits/thread changes, and intercept ArrowUp/ArrowDown only when command menus are closed and the editor is empty or already navigating history.

- [ ] **Step 4: Verify and commit**

Run: `bun run --cwd apps/web test composer-logic.test.ts`
Expected: PASS.

Commit: `feat(web): navigate sent composer history`

### Task 3: Atomic queue editing and compact rows

**Files:**

- Modify: `apps/web/src/composerDraftStore.ts`
- Modify: `apps/web/src/components/ChatView.tsx`
- Create: `apps/web/src/components/chat/ComposerQueue.tsx`
- Test: `apps/web/src/composerDraftStore.test.ts`
- Test: `apps/web/src/components/ChatView.logic.test.ts`

**Interfaces:**

- Produces: `takeQueuedMessage(threadRef, messageId)` returning the removed message, plus Edit/Remove callbacks.

- [ ] **Step 1: Write failing atomic-edit tests**

Cover removal by id, unchanged state for unknown ids, FIFO preservation, draft restoration of prompt/attachments/model/runtime/interaction selections, and resubmission at the tail.

- [ ] **Step 2: Verify failure**

Run: `bun run --cwd apps/web test composerDraftStore.test.ts ChatView.logic.test.ts`
Expected: FAIL on missing atomic take/edit behavior.

- [ ] **Step 3: Implement queue take and rows**

Use one Zustand update to remove and return a queue item. Render one-line preview, nonzero attachment count, Edit, Send now, and Remove above the composer; reuse existing persisted-attachment restoration and cleanup functions.

- [ ] **Step 4: Verify and commit**

Run: `bun run --cwd apps/web test composerDraftStore.test.ts ChatView.logic.test.ts`
Expected: PASS.

Commit: `feat(web): edit queued composer messages`

### Task 4: Active-turn steering

**Files:**

- Modify: `apps/server/src/provider/Services/ProviderAdapter.ts`
- Modify: provider adapters that expose native steering
- Modify: provider service/RPC contracts and routing files discovered from `sendTurn` callers
- Modify: `apps/web/src/components/ChatView.tsx`
- Test: focused provider adapter/service tests
- Test: `apps/web/src/components/ChatView.logic.test.ts`

**Interfaces:**

- Produces: adapter capability `activeTurnSteering` and a steering request that resolves only after provider acceptance.

- [ ] **Step 1: Trace every adapter and send-turn caller**

Run: `rg -n "ProviderAdapterCapabilities|sendTurn" apps/server/src packages/contracts/src apps/web/src`
Expected: complete list of capability constructors and RPC path.

- [ ] **Step 2: Write failing capability and queue-retention tests**

Cover supported/unsupported providers, accepted steering removal, failed steering retention, and no cancellation fallback.

- [ ] **Step 3: Implement the minimal native route**

Add one capability flag and optional adapter operation, expose one RPC method, disable Send now with explanatory text when unsupported, and remove the queue item only after success.

- [ ] **Step 4: Verify and commit**

Run the focused provider and ChatView tests.
Expected: PASS.

Commit: `feat: steer active turns from queued messages`

### Task 5: Follow-up suggestion generation and setting

**Files:**

- Modify: `apps/server/src/textGeneration/TextGeneration.ts`
- Modify: provider text-generation implementations and prompt helpers
- Modify: Native API contracts/routing
- Modify: `packages/contracts/src/settings.ts`
- Modify: web settings UI and `apps/web/src/components/ChatView.tsx`
- Create: `apps/web/src/components/chat/ComposerSuggestions.tsx`
- Test: text-generation parser/provider tests, settings migration tests, and `ChatView.logic.test.ts`

**Interfaces:**

- Produces: `generateFollowUpSuggestions({ modelSelection, transcript }) -> { suggestions: string[] }` and global `automaticFollowUpSuggestions` defaulting to `true`.

- [ ] **Step 1: Write failing parser and lifecycle tests**

Cover malformed output, trimming, deduplication, one-to-three results, 160-character caps, successful-turn-only generation, silent failure, chip-to-draft behavior, and all invalidation events.

- [ ] **Step 2: Verify failure**

Run the focused server and web tests.
Expected: FAIL because the operation and state are absent.

- [ ] **Step 3: Implement out-of-band generation**

Reuse each provider's existing structured text-generation process with a bounded current-turn transcript. Normalize centrally, expose one RPC, request after successful settlement, and render editable chips without submitting.

- [ ] **Step 4: Add the default-on setting**

Extend the existing settings schema with a decoding default of `true`, add the labelled toggle, and gate requests before invoking the server.

- [ ] **Step 5: Verify and commit**

Run focused tests, then `bun fmt`, `bun lint`, `bun typecheck`, and `GITS_REAL_GIT=/usr/bin/git bun run test`.
Expected: all checks PASS.

Commit: `feat: suggest follow-up prompts after successful turns`

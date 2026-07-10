# OpenAI latest-model integration handoff

Status: implementation brief for the Opus agent updating the Effect Schema/Codex app-server integration.

Verified against the official OpenAI model catalog on 2026-07-10.

## Goal

Make the latest OpenAI models available through GITScode's existing Codex provider, with `gpt-5.5` as the default Codex model when the installed Codex app-server reports it.

Do not add a separate OpenAI SDK or direct Responses API provider for this task. GITScode already launches `codex app-server`, calls `model/list`, and converts the returned model metadata into its provider-neutral model schema.

## Current OpenAI models

Use these API model IDs:

| Role                             | Model ID       | Notes                                                                                              |
| -------------------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| Default complex coding/reasoning | `gpt-5.5`      | Current flagship; reasoning efforts `none`, `low`, `medium`, `high`, and `xhigh`                   |
| Lower-cost coding/subagents      | `gpt-5.4-mini` | Current mini model; keep as the Git text-generation default unless product requirements change     |
| Lowest-cost high-volume work     | `gpt-5.4-nano` | Expose when reported by app-server; do not make it the default                                     |
| Maximum-quality API work         | `gpt-5.5-pro`  | Responses API model with materially different latency/cost; do not make it the interactive default |
| ChatGPT Instant alias            | `chat-latest`  | Not recommended for production API integration; do not use as GITScode's default                   |

Official sources:

- [Model selection and current catalog](https://developers.openai.com/api/docs/models)
- [GPT-5.5 model reference](https://developers.openai.com/api/docs/models/gpt-5.5)
- [Model comparison](https://developers.openai.com/api/docs/models/compare)
- [Responses API](https://developers.openai.com/api/docs/guides/responses-vs-chat-completions)

Model availability depends on the authenticated account, Codex release, and rollout. The app-server response is authoritative for the picker; the constants are only fallbacks/defaults.

## Read first

1. `packages/effect-codex-app-server/scripts/generate.ts`
2. `packages/effect-codex-app-server/src/_generated/schema.gen.ts`
3. `packages/effect-codex-app-server/src/_generated/meta.gen.ts`
4. `apps/server/src/provider/Layers/CodexProvider.ts`
5. `packages/contracts/src/model.ts`
6. `apps/web/src/providerModels.ts`
7. `apps/web/src/components/chat/ProviderModelPicker.browser.tsx`

## Existing flow to preserve

```text
installed codex binary
  -> codex app-server
  -> initialize
  -> paginated model/list
  -> Effect-generated V2ModelListResponse schema decode
  -> parseCodexModelListResponse
  -> ServerProviderModel[]
  -> web model picker
```

`CodexProvider.ts` already derives reasoning choices from `supportedReasoningEfforts`, marks `defaultReasoningEffort`, and derives fast mode from `additionalSpeedTiers`. Do not hard-code per-model capability tables.

## Implementation sequence

1. Update `UPSTREAM_REF` in `packages/effect-codex-app-server/scripts/generate.ts` to a reviewed OpenAI Codex commit that contains the current app-server protocol.
2. Run `bun run --filter effect-codex-app-server generate`.
3. Review all generated changes. Confirm `model/list`, `turn/start`, reasoning effort, service tier, and notification schemas still map correctly. Do not hand-edit files under `_generated`.
4. Fix only compile/runtime mappings broken by the upstream schema change. Keep decode boundaries in `effect-codex-app-server`; do not weaken schemas to `Unknown` to make generation pass.
5. Change `DEFAULT_MODEL` in `packages/contracts/src/model.ts` from `gpt-5.4` to `gpt-5.5` only after a current local `codex app-server` probe reports `gpt-5.5` for the authenticated account.
6. Keep `DEFAULT_GIT_TEXT_GENERATION_MODEL` at `gpt-5.4-mini`.
7. Add the minimal alias entries needed for user shorthand, at least `"5.5": "gpt-5.5"`. Do not alias `gpt-5.5` to a Codex-specific slug unless app-server itself reports that slug.
8. Update focused tests that assert the old default or generated protocol shape. Do not rewrite historical migrations or stored fixtures solely because a new default exists.

## Probe before changing the default

Use the repository's existing probe:

```bash
bun run --filter effect-codex-app-server probe
```

If that probe does not print the model list clearly, use the existing typed client path to call `model/list`; do not introduce an OpenAI SDK just for discovery. Check every page until `nextCursor` is null.

Expected model metadata consumed by GITScode includes:

```ts
{
	model: "gpt-5.5",
	displayName: "gpt-5.5",
	defaultReasoningEffort: "medium",
	supportedReasoningEfforts: [
		{ reasoningEffort: "none" },
		{ reasoningEffort: "low" },
		{ reasoningEffort: "medium" },
		{ reasoningEffort: "high" },
		{ reasoningEffort: "xhigh" },
	],
}
```

The exact default effort and optional fields must come from the runtime response. The example is a shape check, not a hard-coded catalog.

## Acceptance criteria

- A signed-in Codex provider shows every model returned by all pages of `model/list`, including `gpt-5.5` when the account exposes it.
- Selecting `gpt-5.5` starts and resumes a thread using that exact model slug.
- The picker shows only the reasoning efforts reported for the selected model.
- `xhigh` survives selection, persistence, resume, and `turn/start` mapping.
- Fast mode appears only when the model reports the `fast` additional speed tier.
- An account without `gpt-5.5` still starts successfully and selects the first reported non-custom model rather than presenting a broken default.
- Existing saved `gpt-5.4` thread selections remain unchanged.
- Generated bindings contain no manual edits.

## Verification

Run focused checks while iterating, then the repository completion checks:

```bash
bun run --filter effect-codex-app-server test
bun run --filter @t3tools/contracts test
bun run --filter t3 test -- CodexProvider
bun fmt
bun lint
bun typecheck
```

Use `bun run test`, never `bun test`, if a broader test run is needed.

## Out of scope

- A direct OpenAI Responses API provider
- API-key management beyond the existing Codex authentication flow
- Pricing tables or billing UI
- Realtime/audio/image-generation provider surfaces
- Changing historical migrations, examples, or unrelated provider defaults
- Making `gpt-5.5-pro` the interactive default

If the product requirement is actually to call OpenAI independently of Codex/ChatGPT authentication, stop and write a separate provider design. That requires Responses API streaming event mapping, tool-call handling, conversation state, API-key storage, retry/rate-limit behavior, and a distinct capability probe.

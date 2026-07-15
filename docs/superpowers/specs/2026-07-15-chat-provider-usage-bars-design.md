# Chat Provider Usage Bars Design

## Goal

Show the active chat provider's 5-hour and weekly account usage directly above the composer for Codex and Claude sessions.

## Scope

- Render only for chats whose selected provider driver is Codex or Claude.
- Show only the selected chat provider; never show both providers together.
- Display one compact row for the 5-hour window and one for the weekly window.
- Each available row shows used percentage, a native progress bar, and reset time.
- Missing provider or window data remains visible as `Usage unavailable`.
- Place the panel above composer suggestions and queued messages so it remains session-scoped and never covers messages.

## Architecture

Reuse the existing authenticated `GET /api/gits/usage` endpoint and `UsageSummary` contract. The web app already uses this endpoint in the Gits cockpit, and the server already normalizes Codex rate-limit windows as `UsageWindowSummary`. No new provider API, persistence layer, runtime event, or dependency is needed.

Extract the existing browser fetch into a small shared web query function so both the cockpit and chat use identical request behavior. `ChatView` enables a TanStack query only while the selected provider is Codex or Claude, refreshes every 60 seconds, and preserves the last successful value during background refreshes.

## Components and Data Flow

1. `ChatView` derives the active driver from `activeProviderStatus.driver`.
2. A shared `readUsageSummary()` helper fetches `/api/gits/usage` and throws on non-success responses.
3. A pure selector filters `UsageSummary.windows` by provider and chooses windows with `windowMinutes` equal to `300` and `10080`.
4. `ComposerUsageBars` renders the two rows immediately above `ComposerSuggestions`.
5. If the request fails, the provider has no windows, or either expected window is absent, that row displays `Usage unavailable` without an error toast.

Codex maps to usage provider `codex`; Claude and Claude Agent map to `claude`. Other drivers do not issue the query and render nothing.

## Presentation

The panel is a compact bordered surface matching existing composer UI. Each row contains the provider/window label, a native `<progress>` element with an accessible label, the rounded used percentage, and a concise reset timestamp when present. Background refresh does not replace good values with a loading state.

## Error and Edge-Case Behavior

- Clamp displayed progress to `0..100`; retain the normalized numeric value only for text rounding.
- Treat absent, invalid, or unmatched windows as unavailable.
- Treat HTTP and decoding failures as unavailable and retry on the next 60-second interval.
- Reset the selected view immediately when the active thread or provider changes; TanStack Query may retain the shared cached summary.
- Do not estimate account limits from token counts because account quotas are provider-controlled and model-dependent.

## Testing

- Add pure selector tests covering provider isolation, 5-hour/weekly matching, missing windows, and percentage clamping.
- Add a focused component test covering both available rows, partial availability, accessible progress labels, and the unavailable state.
- Keep existing endpoint tests as the backend contract check; no backend change is planned.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before completion.

## Deliberate Omissions

- No live app-server rate-limit subscription; 60-second polling is sufficient for slow-moving quota windows.
- No settings toggle, dismissal state, animation, or warning thresholds.
- No fabricated Claude percentage when Claude does not expose rate-limit windows; the explicit unavailable state is truthful.

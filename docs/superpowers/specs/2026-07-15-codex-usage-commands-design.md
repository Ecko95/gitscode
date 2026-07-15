# Codex Usage Commands and Reset Warnings

## Goal

Expose Codex account status and usage controls inside a Codex chat, show expiring usage-limit reset credits, and warn before credits expire. Keep the composer and usage panel aligned to the chat content width while limiting each progress track to 30% of that width.

## User Experience

- `/status` opens a session-scoped status panel for the selected Codex provider.
- `/usage` opens an account usage panel with the five-hour and weekly limits plus available reset credits and their expiry dates.
- Each available reset credit has a redeem action. Consuming it always requires explicit confirmation that includes its expiry date.
- Codex-only commands are offered only in Codex sessions. Other providers retain their existing behavior.
- If account data cannot be read, the panels show `Usage unavailable` without blocking chat.
- The composer and usage panel use the same full chat-content width. Progress tracks use 30% of the available row width and remain usable on narrow screens.

## Server and Data Flow

The server will reuse the Codex app-server client already owned by the active provider session. It will expose the smallest required typed operations through the existing web/server protocol:

1. Read account rate limits, token usage, and reset credits.
2. Consume a selected reset credit by its opaque ID.

The web client will request this data when `/status` or `/usage` is opened and refresh the existing composer usage query after a successful redemption. Sparse rate-limit update notifications will trigger a refetch rather than being treated as a complete account snapshot.

No CLI subprocess or terminal UI emulation will be added.

## Expiry Notifications

Account usage refreshes will inspect available credits with expiry timestamps. Each credit produces at most one warning when it enters the 48-hour window and one when it enters the 24-hour window.

Notification delivery reuses the existing web-push service and subscription setting, allowing browser/system delivery when the relevant chat is not open. If push is unavailable while the app is open, the existing in-app notification surface is used. The feature will not repeatedly prompt for browser permission; permission remains controlled by the existing user-initiated notification setting.

Delivered warning keys are persisted locally using the credit ID and threshold so refreshes and restarts do not repeat a warning. A successful redemption removes the credit from subsequent checks naturally.

## Error Handling and Safety

- Reset-credit IDs are accepted only from the latest server-provided account snapshot.
- Redemption failures keep the confirmation panel open and show the returned error.
- Missing expiry dates remain visible as `Expiry unavailable` and do not schedule warnings.
- Notification failures never affect usage display, redemption, or chat sending.
- Account operations are rejected for non-Codex sessions.

## Verification

- Unit tests cover command parsing, Codex-only command visibility, account response mapping, reset confirmation, and 48-hour/24-hour warning deduplication.
- Component tests cover full-width layout, 30% progress tracks, unavailable states, credit expiry display, and redemption errors.
- Required repository checks: `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`.

## Explicit Non-goals

- Reproducing the Codex CLI terminal menus.
- Automatically redeeming reset credits.
- Guaranteeing warnings before the account has supplied a reset-credit snapshot. Once credits have been read, warning state is retained across chat navigation and application restarts.
- Usage/reset support for providers other than Codex.

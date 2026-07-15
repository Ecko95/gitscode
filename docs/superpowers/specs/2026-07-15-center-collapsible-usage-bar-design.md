# Centered Collapsible Usage Bar

## Goal

Keep the composer usage display visually centered and let users reclaim its vertical space without making the control hard to rediscover.

## Design

- The usage panel continues to span the composer width.
- Each available usage progress bar remains 30% wide and is centered within its row. Labels and reset details stay readable beside it.
- A chevron button sits at the far right of the panel and exposes an accessible collapse/expand label.
- Expanded mode shows the existing 5-hour and weekly rows.
- Collapsed mode shows a slim, full-width `Usage` strip and the expand chevron.
- The browser stores the collapsed preference in `localStorage`. Storage failures fall back to expanded mode without affecting chat.

## Scope

The slash-command menu currently decides whether to show Codex commands from the
composer-selected provider, while submission gates them on a separately resolved active-provider
snapshot. If those values differ or the snapshot is temporarily unavailable after reconnect, the
command silently returns. Command visibility and execution must use the same composer-selected
provider, and an unsupported command must produce visible feedback instead of doing nothing.

The change is confined to the existing composer usage component, command submission path, and
focused tests. It adds no dependency or new shared abstraction.

## Verification

The component test verifies centered progress styling, the far-right accessible toggle, and both
expanded and collapsed rendering. A command-routing regression test verifies that the provider
selected in the composer controls Codex command handling. Repository format, lint, typecheck, and
test commands remain the completion gates.

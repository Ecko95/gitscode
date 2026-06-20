---
name: visual-plan
description: Use when the user asks you to plan a feature, change, or task and wants to review it visually — renders an interactive, structured plan in the GITS visual plan side panel instead of a wall of chat text. Trigger on "plan", "visual plan", "render a plan", or when entering plan mode in GITS.
---

# Visual Plan

GITS hosts a native visual-plan MCP server (`gits-visual-plan`). Instead of dumping a
plan into chat, author a **structured block document** that renders live in the GITS
visual plan side panel, where the user can read, edit, and comment on it. The document
is the source of truth, not the chat.

## Tools

All tools are exposed by the `gits-visual-plan` MCP server (call them as
`mcp__gits-visual-plan__<tool>`):

- `get-plan-blocks` — the authoritative block catalog. **Always call this first.**
- `create-visual-plan` — create/replace the plan: `{ title?, brief?, content }`.
- `update-visual-plan` — apply `{ contentPatches }` (targeted edits).
- `get-visual-plan` — read the current plan JSON.
- `get-plan-feedback` — read the user's anchored comments. **Call before editing.**
- `export-visual-plan` — get the plan + open comments as one markdown document.

## Workflow

1. **Research first.** Inspect the real files, symbols, and schema you'll touch. Name
   them concretely in the plan — never plan against imagined code.
2. **Call `get-plan-blocks`** to load the current block catalog.
3. **Author `content`** as `{ version: 1, title, brief, blocks: [...] }` and call
   `create-visual-plan`. Lead with the outcome (a `rich-text` block), then break the
   work into the right blocks:
   - `rich-text` for prose/rationale (GFM markdown).
   - `checklist` for the step-by-step task breakdown.
   - `annotated-code` / `implementation-map` / `file-tree` for the files you'll change.
   - `api-endpoint` / `data-model` for contracts and schema.
   - `callout` with `tone: "decision"` for hard-to-reverse choices; `tone: "risk"` for risks.
   - `question-form` (single block, at the end) for open questions needing the user's call.
3. **Tell the user** the plan is rendering in the GITS visual plan panel and ask them to
   review, edit, and comment there. **Do not start implementing** until they approve.
4. **Before revising,** call `get-plan-feedback`. Act on comments whose
   `resolutionTarget` is `"agent"`; apply targeted `update-visual-plan` patches rather
   than recreating the whole plan.
5. When the user approves, implement from the plan (and their edits/comments).

## Discipline

- Planning is read-only — make no source edits until the user approves the plan.
- Decide the load-bearing bets up front (wire formats, public ids, data-model shape,
  auth boundaries) and record them as `decision` callouts.
- Don't ship a single-step plan; if the work is trivial, just do it.

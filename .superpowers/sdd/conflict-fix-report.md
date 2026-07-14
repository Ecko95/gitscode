# Conflict-copy data-safety fix

- Root cause: conflict copies used replacement writes and were included as unmapped local notes on the next sync.
- Fix: conflict copies use create-only atomic writes with numeric collision suffixes; filenames containing ` (Notion conflict ` are excluded from normal sync uploads.
- Regression: repeated dual edits retain `remote first` and `remote second` in separate conflict files and make no Notion create request for either copy.

Verification:

- `bun run --cwd apps/server test -- src/gits/Layers/GitsNotes.test.ts` — 19 passed.
- `bun fmt` — passed.
- `bun lint` — passed (60 existing warnings, 0 errors).
- `bun typecheck` — passed (existing suggestions only).

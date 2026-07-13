# VPS Agent Stack: Codex, Claude Code, and Open GSD

## Goal

Install one shared, durable agent workflow on the VPS without duplicating overlapping frameworks.

## Recommended baseline

Install:

- Codex CLI
- Claude Code
- Open GSD Core
- Ponytail
- Superpowers
- Context7
- Frontend Design
- Figma only when the VPS needs Figma work

Do not install the legacy `glittercowboy/get-shit-done` workflow beside Open GSD Core. They overlap. Use Open GSD Core as the shared workflow framework.

## 1. Install the coding CLIs

```bash
# Codex: follow the OpenAI CLI installer for the host.
codex --version

# Claude Code: requires Node.js 18+; Node 22+ is a sensible VPS baseline.
npm install -g @anthropic-ai/claude-code
claude doctor
```

Authenticate each CLI interactively after installation. Never put API keys or OAuth tokens in this document or commit them to a repository.

## 2. Install Open GSD Core

Open GSD Core adds the same planning, execution, verification, and shipping discipline to Codex and Claude Code.

```bash
npx @opengsd/gsd-core@latest
```

In the installer, select the desired runtime(s) and global installation. Let the installer write the runtime-specific files; do not manually copy `commands/` or `agents/` directories.

Useful command flow:

```text
/gsd-new-project     # new repository
/gsd-onboard         # existing repository
/gsd-discuss          # capture decisions
/gsd-plan-phase       # produce an implementation plan
/gsd-execute-phase    # implement
/gsd-verify           # validate before claiming completion
/gsd-ship             # handoff / PR workflow
```

## 3. Codex plugins

```bash
codex plugin marketplace add anthropics/claude-plugins-official
codex plugin add context7@claude-plugins-official
codex plugin add frontend-design@claude-plugins-official
codex plugin add skill-creator@claude-plugins-official
codex plugin add superpowers@claude-plugins-official

codex plugin marketplace add DietrichGebert/ponytail --ref v4.8.4
codex plugin add ponytail@ponytail

# Optional: only for Figma-backed work.
codex plugin add figma@openai-curated
```

## 4. Claude Code plugins

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install context7@claude-plugins-official
claude plugin install frontend-design@claude-plugins-official
claude plugin install skill-creator@claude-plugins-official
claude plugin install superpowers@claude-plugins-official

claude plugin marketplace add DietrichGebert/ponytail --ref v4.8.4
claude plugin install ponytail@ponytail

# Optional: only for Figma-backed work.
claude plugin install figma@claude-plugins-official

# Optional: only if Claude should launch/use Codex.
claude plugin marketplace add openai/codex-plugin-cc
claude plugin install codex@openai-codex

# Optional: install only for projects that use Supabase.
claude plugin install supabase@claude-plugins-official
```

## 5. MCP services

Install only services that have a real VPS use case.

| Service     | Use it when                                               | Notes                                           |
| ----------- | --------------------------------------------------------- | ----------------------------------------------- |
| Context7    | Up-to-date package/framework docs are valuable            | Recommended                                     |
| Figma MCP   | The VPS does Figma design or design-to-code work          | Requires Figma authentication                   |
| Notion MCP  | Agents must read/write workspace docs                     | Requires OAuth; keep it user-scoped             |
| gsd-browser | Browser automation, UI verification, screenshots          | Requires Chrome/Chromium; use headless on a VPS |
| Delamain    | You deploy its custom local server and peer orchestration | Not a generic install                           |

Example hosted MCP connections for Codex:

```bash
codex mcp add notion --url https://mcp.notion.com/mcp
codex mcp login notion

codex mcp add figma --url https://mcp.figma.com/mcp
codex mcp login figma
```

## What each core plugin is for

| Plugin          | Keep it for                                                                           |
| --------------- | ------------------------------------------------------------------------------------- |
| Ponytail        | Minimum viable diffs, reuse-first engineering, avoiding unnecessary dependencies      |
| Superpowers     | Structured planning, debugging, TDD, verification, worktree workflows                 |
| Context7        | Current official library/API documentation                                            |
| Frontend Design | Product-quality UI implementation guidance                                            |
| Skill Creator   | Writing and maintaining custom reusable skills                                        |
| Figma           | Figma context, variables, diagrams, design-to-code workflows                          |
| Open GSD Core   | Durable project plans/state and discuss -> plan -> execute -> verify -> ship workflow |

## Open GSD Pi: optional, not the default

Use GSD Pi only if the VPS needs Open GSD's standalone local-first agent CLI. It has its own `.gsd/` project state and provider/session workflow.

```bash
npx @opengsd/gsd-pi@latest
gsd
```

Do not start with both GSD Pi and GSD Core in the same repository. Start with GSD Core because Codex and Claude Code remain the primary runtimes; add Pi later only if its standalone auto mode is specifically wanted.

## Verification checklist

```bash
codex --version
codex plugin list
codex mcp list

claude --version
claude doctor
claude plugin list

npx @opengsd/gsd-core@latest --help
```

In a throwaway Git repository, confirm that Open GSD can onboard the project, write its durable planning artifacts, and run one small planned task before using it on production repositories.

## Sources

- https://github.com/open-gsd/gsd-core
- https://github.com/open-gsd/gsd-pi
- https://github.com/DietrichGebert/ponytail
- https://docs.anthropic.com/en/docs/claude-code/getting-started

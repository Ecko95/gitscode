# GITS Skills Intelligence Plan

## Objective

Add a native GITS cockpit surface for skills across Codex, Claude, Cursor, and future providers. The first version inventories local skills read-only, then adds review, ratings, usage telemetry, portability status, and HERMES-assisted improvement proposals.

This work must stay separate from the RTK output gateway branch. RTK changes how shell output is captured and compressed; Skills Intelligence changes how GITS understands the user's agent capability library.

## Current Signals

- Codex already exposes provider skills through the app-server `skills/list` RPC and GITS web has `$skill` search/chips built on the existing provider skill contract.
- Claude sessions are launched with the configured home path and user/project/local setting sources, so Claude can use local Claude skills at runtime, but GITS does not inventory them as cockpit skills yet.
- Cursor ACP is launched from the project cwd with the normal environment, so Cursor can use local Cursor configuration, but GITS does not inventory Cursor skills/rules yet.
- The GITS cockpit already owns typed read-only project state, Delamain controls, Open GSD controls, automode policy, and provider runtime usage visibility.

## Product Surface

Add a new `Skills` tab in the GITS cockpit.

The tab should support:

- Provider filters: Codex, Claude, Cursor, GITS, and unknown/future.
- Kind filters: skill, agent, rule, slash command, prompt, workflow.
- Search across name, display name, description, tags, source path, and provider.
- A detail panel for source file, summary, provider compatibility, usage stats, rating, review notes, and improvement history.
- Rating controls for quality, reliability, portability, and usefulness.
- Review controls for canonical source, duplicate-of, ignored, needs port, needs rewrite, and safe for automode.
- Insight cards for most used, stale but used, duplicate skills, weak descriptions, missing provider ports, and high-value HERMES candidates.

## Data Model

Add GITS-specific contracts in `packages/contracts/src/gits.ts`.

Recommended entities:

- `GitsSkillProvider`: `codex | claude | cursor | gits | unknown`.
- `GitsSkillKind`: `skill | agent | rule | slash-command | prompt | workflow | unknown`.
- `GitsSkillSummary`: normalized inventory row with stable id, provider, kind, name, display name, description, source root, source path, enabled flag, file hash, last modified time, tags, and portability status.
- `GitsSkillReview`: local operator annotations, canonical provider, duplicate relationship, review notes, safety flags, and last reviewed time.
- `GitsSkillRating`: 1-5 ratings for usefulness, reliability, clarity, portability, and automation safety.
- `GitsSkillUsageStats`: invocation count, last used time, project/repo associations, approximate token/cost correlation, and recent outcomes.
- `GitsSkillInventorySnapshot`: scanned time, skills, totals, warnings, and insights.
- `GitsSkillImprovementCandidate`: HERMES queue item with evidence, reason, priority, proposal status, and target provider/source path.

Stable ids should be derived from provider, kind, normalized source path, and name. File hashes should be used for change detection, not as ids.

## Server Architecture

Create a server-owned registry instead of making the browser read local homes directly.

Proposed files:

- `apps/server/src/gits/Services/GitsSkillRegistry.ts`
- `apps/server/src/gits/Layers/GitsSkillRegistry.ts`
- `apps/server/src/gits/Layers/GitsSkillRegistry.test.ts`

The registry should:

- Scan known local roots without mutating them.
- Normalize provider-specific shapes into `GitsSkillSummary`.
- Persist user annotations separately under the server state directory, for example `gits/skills-state.json`.
- Merge inventory, reviews, ratings, and usage into one cockpit snapshot.
- Fail soft: missing provider homes produce warnings, not cockpit failure.

Initial discovery roots:

- Codex: configured `CODEX_HOME/skills`, default `~/.codex/skills`, and app-server `skills/list` where available.
- Claude: configured Claude home, default `~/.claude/skills`, `~/.claude/agents`, and slash command metadata where available.
- Cursor: `~/.cursor/skills`, `~/.cursor/skills-cursor`, project rules, and Cursor provider settings when available.
- GITS: future canonical GITS skill packages under the server state directory or a configured workspace root.

Initial RPC methods:

- `gits.skills.snapshot`: return merged inventory, reviews, ratings, usage, and insights.
- `gits.skills.refresh`: force a rescan.
- `gits.skills.review.update`: write review metadata for a skill id.
- `gits.skills.rating.update`: write rating metadata for a skill id.
- `gits.skills.improvement.enqueue`: enqueue a HERMES improvement candidate.

## Usage Telemetry

Track usage from low-risk signals first:

- `$skill` chips inserted in the composer.
- Prompt text references that exactly match a known `$skill-name`.
- Provider runtime activity correlated to an active selected skill when the UI launch path is explicit.
- HERMES improvement jobs and resulting accepted or rejected proposals.

Avoid claiming hard success metrics at first. Use proxy metrics:

- Used in prompt count.
- Used in project count.
- Last used time.
- Related repositories.
- Manual rating trend.
- Improvement proposal accepted/rejected count.

The existing automode usage meter is the right pattern for cost/token correlation. Skill usage should not block the provider runtime path if usage attribution is unavailable.

## HERMES Improvement Loop

HERMES should start as a proposal engine, not an automatic file editor.

Inputs:

- Skill source content.
- Provider type and compatibility target.
- Usage frequency.
- User ratings and review notes.
- Recent project context where the skill was used.
- Failure or friction signals if available.

Outputs:

- Review summary.
- Risk flags.
- Suggested patch.
- Provider portability notes.
- Regression checklist.

Write flow:

1. Enqueue candidate from cockpit.
2. Generate proposal and store it in GITS state.
3. Show diff/proposal in the skill detail panel.
4. Require explicit approval before writing back to `~/.codex`, `~/.claude`, `~/.cursor`, or a GITS canonical skill store.

## Safety Rules

- Phase 1 is read-only inventory only.
- Do not edit local provider skill directories without explicit approval.
- Do not delete or rewrite provider skills from GITS.
- Store GITS reviews and ratings separately from provider source files.
- Use structured parsers for frontmatter/JSON/YAML where possible.
- Treat secrets in skill files as sensitive and avoid sending full content to HERMES unless the user approves.

## Implementation Slices

1. Contracts and registry skeleton
   - Add schemas and RPC contract shape.
   - Add read-only registry service with empty snapshot and tests.

2. Cross-provider scanners
   - Add Codex filesystem scanner.
   - Add Claude skills and agents scanner.
   - Add Cursor skills/rules scanner.
   - Normalize descriptions from `SKILL.md`, agent markdown frontmatter, and rule metadata.

3. Cockpit Skills tab
   - Add tab navigation to `GitsCockpit`.
   - Render inventory table, filters, search, warnings, and detail panel.

4. Ratings and reviews
   - Add state file persistence.
   - Add rating and review mutations.
   - Merge annotations into snapshot.

5. Usage telemetry
   - Capture explicit `$skill` chip usage.
   - Add usage aggregation to the registry snapshot.
   - Add insights cards.

6. HERMES proposals
   - Add improvement candidate queue.
   - Add proposal model and cockpit review UI.
   - Keep write-back approval-gated.

## Peer Strategy

This feature can be parallelized after the contracts are established:

- Peer A: contracts, RPC methods, server registry skeleton.
- Peer B: Codex, Claude, and Cursor scanner implementations.
- Peer C: cockpit Skills tab and detail panel.
- Peer D: ratings/review persistence and tests.
- Peer E: usage telemetry and HERMES proposal queue.

Avoid parallel edits to `packages/contracts/src/gits.ts` until Peer A lands, because every other slice depends on the contract names.

## Acceptance Criteria

- GITS cockpit has a `Skills` tab.
- The tab lists local Codex, Claude, and Cursor skills/agents/rules from the user's machine.
- Missing provider directories render warnings without breaking the cockpit.
- The user can rate and review a skill without modifying provider source files.
- Ratings and reviews survive server restart.
- The cockpit shows at least invocation count, last used time, and provider coverage insights.
- HERMES improvement candidates can be queued and reviewed before any provider files are changed.

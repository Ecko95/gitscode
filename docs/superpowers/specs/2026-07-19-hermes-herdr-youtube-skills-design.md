# Hermes Herdr and YouTube Skills Design

## Goal

Give Codex, Claude, and Hermes one maintained set of skills for YouTube transcript analysis and safe Herdr orchestration. The Gits-managed Hermes profile remains the primary command centre and the only Hermes profile polling Telegram.

## Shared installation

Canonical skill directories live under `~/.agents/skills`. Agent-specific skill directories contain symlinks to those canonical copies:

- Codex: `~/.codex/skills`
- Claude: `~/.claude/skills`
- Personal Hermes: `~/.hermes/skills`
- Gits Hermes: `~/.gits/hermes/skills`

This prevents agent-specific copies from drifting. Existing destinations must be inspected before links are created; unrelated or user-modified skills are never overwritten.

## Newsletter curator storage

YouTube skills write their durable output to a dedicated checkout of `Ecko95/newsletter-curator`, configured by `NEWSLETTER_CURATOR_DIR`. Installation configures the Ops host checkout outside the Gits repository. Skill runs preserve the repository's existing organization:

- Video records: `transcripts/<title-slug>-<video-id>.md`
- Search records: `transcripts/searches/search-<YYYY-MM-DD>-<query>.md`
- Curated editions: `transcripts/newsletters/<YYYY-Wnn>.md` (owned by the curator, not these skills)

Each invocation pulls with rebase before writing, stages only the exact files it produced, commits them, and pushes to `Ecko95/newsletter-curator`. A push race gets one pull/rebase-and-retry attempt; unresolved conflicts are reported without force-pushing or modifying unrelated files. A video ID makes transcript filenames and downstream records idempotent.

## `yt-search`

Port `Ecko95/jdu-skills/yt-search` as a metadata-only YouTube search:

1. Accept slash-command or natural-language search input.
2. Return 10 results by default, accept an explicit result count, and cap it at 50.
3. Show title, channel, duration, views, upload date, and URL without downloading video or audio.
4. Save and push the search result Markdown file.
5. Ask which results the operator wants to transcribe and pass the selected URLs to `yt-transcribe`.

Search records are not synced to Notion. Only selected and transcribed videos become durable video records.

## `yt-transcribe`

Port `Ecko95/jdu-skills/yt-transcribe` without changing its interaction model:

1. Fetch subtitles with `yt-dlp`.
2. Prefer manual English, generated English, manual subtitles in another language, then generated subtitles in another language.
3. Return the title and normalized transcript.
4. Save and push one Markdown video record keyed by YouTube video ID.
5. Ask whether the operator wants a summary, action items, or a custom prompt.
6. Treat transcript search and questions as custom prompts over the fetched text.

The port replaces the Claude-specific script path with instructions that resolve the script relative to the loaded skill directory. It must not install packages implicitly or invoke `pip --break-system-packages`; when `yt-dlp` is missing, it returns a concise installation requirement.

Each video record preserves the repository's existing heading and metadata format, adds an explicit video ID, and contains a `## Transcript` section. Requested summaries, action items, or custom analysis are appended as optional sections and update the same file rather than creating another record.

Validation covers VTT cleanup and duplicate removal, missing `yt-dlp`, invalid or unavailable transcripts, and static skill validation. A live YouTube smoke check may be used when network access is available, but is not required for deterministic validation.

## Git-to-Notion synchronization

Notion synchronization is a separate cloud routine in `Ecko95/newsletter-curator`; the interactive skills never call Notion. A GitHub Actions workflow runs when video records under `transcripts/*.md` change, excluding `transcripts/searches/` and `transcripts/newsletters/`.

The routine creates or updates one Notion database item per YouTube video ID. Metadata is stored as properties and the transcript, summary, action items, and custom analysis are stored in the page body. Reprocessing the same video updates its existing item. Notion credentials and database identifiers live only in GitHub Actions secrets.

This keeps Notion retries, API limits, and schema changes out of Codex, Claude, and Hermes conversations. Transcript tokens are consumed only when the operator requests analysis of the transcript itself.

## `herdr` low-level skill

The existing `herdr` skill remains the authoritative command and safety reference. Its normal pane-local mode continues to require `HERDR_ENV=1`.

A headless mode is added for the Gits Hermes systemd service:

- The caller must explicitly set `HERDR_HEADLESS=1`.
- The skill verifies that the configured Herdr server/socket is available and owned by the current Unix user.
- Headless operations always discover and use explicit workspace, tab, and pane IDs.
- Headless operations never use `--current`, infer an ID, attach the TUI, or stop the default server.

The Gits and Hermes services receive headless access through explicit service configuration rather than pretending to be pane-local with `HERDR_ENV=1`.

## `herdr-orchestration`

`herdr-orchestration` is a higher-level companion skill and declares the existing `herdr` skill as required background. It provides workflows for:

- Listing Herdr sessions, workspaces, tabs, panes, detected agents, and agent states.
- Reading recent agent chats and terminal output.
- Sending initial prompts and follow-up messages.
- Spawning an agent in a sibling pane with safe geometry and no focus theft.
- Waiting for `working`, `idle`, `done`, or `blocked`, then reading the result.
- Producing a concise cross-workspace activity summary.

### Ownership and destructive operations

Existing resources may be inspected, messaged, and waited on. The skill may close or delete only an exact resource ID returned by a create or split operation during the current orchestration task. Ownership is intentionally turn-local; persistent ownership storage is deferred until a demonstrated cross-session cleanup need exists.

The skill never:

- Stops or deletes the default Herdr session.
- Closes a pre-existing workspace, tab, or pane.
- Constructs IDs from workspace numbers or display order.
- Sends input to the UI-focused pane without first resolving an explicit ID.
- Treats `idle` as proof that work ran; it verifies the expected `working` transition or reads output after a timeout.

## Telegram and Gits policy

`~/.gits/hermes` is the canonical persistent Hermes profile. Its gateway is the sole Telegram poller. The personal `~/.hermes` profile remains available for local CLI use but does not run a Telegram gateway.

The current Gits `observe-propose-only` policy remains intact for repository writes, merges, destructive shell operations, and Delamain execution. Herdr receives a narrow exception for inspection, messaging, waiting, and agent spawning. Closing resources remains subject to the ownership rule above.

Before enabling the Gits gateway, the competing Telegram poller must be found and stopped so only the managed gateway uses `getUpdates`.

## Verification

Skill work follows failing-check-first development:

1. Confirm the original `yt-transcribe` fails outside Claude because of its hard-coded path and implicit installer behavior.
2. Confirm Gits Hermes cannot discover `yt-transcribe` or `herdr-orchestration` before installation.
3. Confirm headless Herdr access is rejected without its explicit opt-in and ownership checks.
4. Validate every created or modified skill directory with the skill validator.
5. Confirm `yt-search` saves the existing search Markdown format and hands selected URLs to `yt-transcribe`.
6. Confirm transcript reruns produce the same video-ID filename and the Git commit stages no unrelated files.
7. Test the cloud sync against fixtures for create, idempotent update, ignored search files, and missing credentials.
8. Exercise orchestration in an isolated named Herdr test session: inspect, spawn, message, wait, read, and close only the created pane.
9. Confirm a pre-existing pane and the default session cannot be closed through the workflow.
10. Run repository-required `bun fmt`, `bun lint`, and `bun typecheck` if repository files change during implementation.

## Deferred

- A new Herdr MCP server or orchestration daemon.
- Persistent ownership ledgers across agent sessions.
- A separate YouTube search API.
- Automatic dependency installation from inside the skill.

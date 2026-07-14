# Dev Notes Design

## Goal

Add a GITS Dev Notes area that stores one note per Markdown file in a durable server-side vault and synchronizes those notes with a dedicated Notion data source.

## Decisions

- Add **Dev Notes** above **GITS Cockpit** in the global sidebar and serve the app at `/notes`.
- Store the vault in `GITS_NOTES_DIR`, defaulting to `~/.gits/notes`; deployment must mount that directory as persistent storage.
- Notes are normal `.md` files and are the source format. Obsidian can open the vault directly; Notion imports/exports through its Markdown API.
- The UI has a search-filtered list, title/content editor, and per-note Edit/Preview toggle. Preview uses the existing `react-markdown` and `remark-gfm` dependencies.
- Ensure the requested seed note exists without overwriting an existing file:
  `VPS localhost callback redirect for windows powershell.md` containing
  `ssh -N -o ExitOnForwardFailure=yes -L 1455:127.0.0.1:1455 user@your-vps`.
- Configure Notion with server-only `GITS_NOTES_NOTION_TOKEN` and `GITS_NOTES_NOTION_DATA_SOURCE_ID`. Never return the token to a browser client.
- Sync manually on demand and after a successful local save. A refresh pulls remote changes. There is no background polling worker in this first version.
- Use YAML frontmatter in each Markdown file for the Notion page ID and last synchronized content hash. It keeps the mapping beside its note and avoids a second database.
- If both versions changed since the shared hash, retain the local file and create `<stem> (Notion conflict YYYY-MM-DDTHH-mm-ssZ).md` from the remote content instead of silently overwriting either version.

## Notion Setup

Create a parent page named **GITS Dev Notes**, then create its Notes database/data source with a required title property named `Name`. Share it with the server integration. The connection is not available in the current coding session, so its data-source ID must be added to deployment configuration once the authenticated Notion connector is available.

## Boundaries

- No Notion OAuth flow, settings UI, scheduled sync, folders, attachments, collaboration, or rich-text editor.
- Notion-only blocks that cannot round-trip through Markdown are represented by Notion’s enhanced Markdown output; the UI renders supported Markdown normally.

## Error Handling

The server validates note IDs/filenames, rejects traversal and non-Markdown paths, creates the vault on demand, writes through a temporary sibling followed by rename, and maps filesystem/Notion failures to typed GITS notes RPC errors. The UI keeps unsaved editor text after a failed save and displays the returned error.

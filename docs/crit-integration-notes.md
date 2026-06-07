# Crit Integration — Discovery Notes

Findings captured during Phase 0 of the crit PR review integration. Later phases read exact values from here.

## License

- **SPDX:** MIT
- **Copyright:** (c) 2026 Tomasz Tomczyk
- **Redistribution:** allowed (MIT permits use, copy, modify, distribute, sublicense).
- **Decision:** Bundling crit binaries inside the GITS app (Phase 7) is permitted. Include the MIT notice with the bundled binary per the license's attribution clause.

## CLI

> **PENDING (Task 0b).** Requires Go to build crit from source, which is not available in the
> current environment. Record here: how to point crit at a repo root + branch/PR, how to set the
> bind host (`127.0.0.1`) + port, how to set `agent_cmd` non-interactively, and crit's
> "server ready" signal (URL/port). Until captured, `crit-sidecar-manager.ts` uses clearly-marked
> placeholder flags (`--repo`, `--branch`, `--host`, `--port`, `--agent-cmd`).

## agent_cmd stdin

> **PENDING (Task 0c).** Requires a running crit instance to capture. Record the exact payload crit
> pipes to `agent_cmd` on stdin (JSON vs plain text; field names for comment text, quoted text,
> file path, line range). Until captured, `crit-agent-cli.ts#parse_crit_payload` assumes JSON
> `{ comment, quoted, filePath, startLine, endLine }` with a plain-text fallback.

## Binary distribution

> **PENDING (Task 7).** Record whether binaries are committed (Git LFS) or fetched/built in CI.

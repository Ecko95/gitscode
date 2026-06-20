# Crit Integration — Discovery Notes

Findings captured during Phase 0 of the crit PR review integration. Later phases read exact values from here.

## License

- **SPDX:** MIT
- **Copyright:** (c) 2026 Tomasz Tomczyk
- **Redistribution:** allowed (MIT permits use, copy, modify, distribute, sublicense).
- **Decision:** Bundling crit binaries inside the GITS app (Phase 7) is permitted. Include the MIT notice with the bundled binary per the license's attribution clause.

## CLI — RESOLVED (crit v0.16.1, captured 2026-06-09)

crit has **no `--repo`/`--branch`/`--agent-cmd` flags** — the placeholders were wrong. The real model:

- **Repo selection:** crit reviews the repository at its **working directory** (auto-detects git).
  The sidecar spawns crit with `cwd = workspaceRoot` (no `--repo`). Targets can also be given via
  `crit <file|dir>`, `crit --pr <num|url>`, or `crit --range <base>..<head>`.
- **Bind:** `--host <h>` (default `127.0.0.1`), `-p/--port <n>` (default random). Env: `CRIT_HOST`,
  `CRIT_PORT`.
- **Headless sidecar flags:** `--no-open` (don't launch a browser) and `-q/--quiet` (suppress
  status) are **required** for a managed sidecar.
- **Base diff (optional, future):** `--base-branch <branch>` overrides auto-detection. We currently
  rely on auto-detect; wiring the PR's base branch / `--pr` is a refinement.
- **Readiness:** crit serves the review UI at `http://<host>:<port>`; any HTTP response means it's
  up (the manager's readiness probe). Smoke-tested: serves HTTP 200 within ~1s.
- **agent_cmd is config-only, NOT a flag.** crit reads `agent_cmd` from its **global config**
  `~/.crit.config.json` (`globalConfigPath()` → `os.UserHomeDir()` = `$HOME`); project-level
  `.crit.config.json` is read but security-restricted. To wire our wrapper without clobbering the
  user's real `~/.crit.config.json`, the manager spawns crit with an **isolated `HOME`** (a scoped
  temp dir, removed on teardown) containing a `.crit.config.json` of `{ "agent_cmd": "<wrapper>" }`.

Effective sidecar invocation: `crit --host 127.0.0.1 --port <p> --no-open --quiet`, `cwd=repoRoot`,
`env: { HOME=<isolated>, GITS_ORIGIN, GITS_TOKEN, GITS_THREAD_ID }`. See `build_crit_spawn_spec`.

## agent_cmd stdin — RESOLVED (from crit source `server.go` buildAgentPrompt/runAgentCmd)

crit pipes a **plain-text prompt** to `agent_cmd` on stdin (or substitutes a `{prompt}` arg
placeholder), runs it with `cwd = RepoRoot`, and **captures the agent's stdout (trimmed) as the
comment reply**. The prompt format:

```
A reviewer left a comment on <filePath> (lines <start>-<end>):

Code:
```

<quoted code, if any>

```

Comment:
> <body>

[Reply from <author>:
> <body> ...]

Address this comment. If it requires a code change, make the edit.
IMPORTANT: Do NOT run `crit comment` or `crit` commands. Just print your response to stdout — it will be posted as a reply automatically.
```

So the wrapper (`crit-agent-cli.ts`) **forwards stdin verbatim** as the GITS thread's user message
(no JSON parsing) and writes the thread's reply to stdout. The earlier JSON
`{ comment, quoted, filePath, startLine, endLine }` assumption was wrong and has been removed.

## Binary distribution — RESOLVED

Prebuilt releases exist at <https://github.com/tomasz-tomczyk/crit/releases> (e.g.
`crit-linux-amd64`, checksummed in `checksums.txt`). No Go build required. For the WSL-hosted
service, crit v0.16.1 is installed at `~/.local/bin/crit` (on the service PATH via the
`gits-cockpit` systemd drop-in), so `resolve_crit_binary_path`'s PATH fallback finds it; an explicit
`GITS_CRIT_BINARY` override is also honored. Per-platform app bundling (electron `extraResources`)
remains the Phase-7 packaging task.

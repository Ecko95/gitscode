# RTK Output Gateway Plan

## Goal

Integrate RTK as a native, conservative output gateway for GITS without changing the default behavior of T3 Code provider sessions.

RTK has two different uses:

- Display compaction: reduce output stored or shown by GITS after a command has already run.
- Agent token compaction: rewrite or filter commands before provider tools send raw output back into the model context.

Agent token compaction is the higher-value path, but it must be opt-in and provider-aware.

## Non-Negotiables

- Default behavior must remain unchanged unless an RTK setting or environment flag is enabled.
- Do not apply RTK to machine-parsed JSON, NDJSON, protocol messages, approval payloads, or RPC payloads.
- Preserve raw output when parsing correctness matters.
- Prefer command-specific RTK wrappers such as `rtk gh`, `rtk git`, `rtk tsc`, `rtk vitest`, and `rtk pipe -f <filter>` over generic truncation.
- If RTK is unavailable, fail open to the existing command path.
- Never expose secrets while reporting rewritten commands or output samples.

## Proposed Server Controls

Environment flags should be enough for the first implementation:

- `GITS_RTK_BIN`: explicit RTK binary path. Falls back to `RTK_BIN`, then `rtk`.
- `GITS_RTK_OUTPUT_GATEWAY`: enables server-side output compaction for human-facing command output.
- `GITS_RTK_REWRITE_TOOLS`: enables provider tool command rewriting where supported.
- `GITS_RTK_ULTRA_COMPACT`: passes `--ultra-compact` to RTK where supported.

## Integration Tracks

### 1. Server Process Runner

Add a small RTK gateway utility and wire it only into places that opt into human-facing output transformation. Keep the existing `ProcessRunner` truncation behavior intact.

### 2. GITS CLI Adapters

Move Delamain and Open GSD adapters away from raw `execFile` helpers toward shared process execution primitives. RTK output compaction must not touch JSON that is decoded into contracts.

### 3. Claude Provider Tool Rewriting

Claude has a `canUseTool` interception point. When enabled, rewrite shell/Bash command tool inputs with `rtk rewrite` before allowing the tool. If RTK declines to rewrite, use the original input.

### 4. Codex Provider Guidance

Codex app-server currently emits command-output events after the provider has already run the command. Until Codex exposes a command rewrite hook through the app-server protocol, use developer-instruction guidance and display compaction only.

### 5. Cockpit Visibility

Expose RTK availability and mode in the GITS cockpit after the execution pieces are stable. `rtk gain` can be used as a local optional savings signal.

## Verification

- Unit tests for command rewrite parsing, RTK unavailable fallback, and JSON-preservation behavior.
- Adapter tests for Delamain/Open GSD JSON command paths.
- Provider tests for Claude Bash command rewriting and no-op fallback.
- Targeted typecheck/test commands for changed packages.

import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

/**
 * Exact env var names allowed through to every provider child process.
 * Prefixes are matched in ALLOWED_PREFIXES below.
 *
 * W5.2b security fix: provider children previously inherited the full server
 * process.env — unrelated credentials (SPLITWISE_*, GITHUB_TOKEN, etc.) were
 * visible to every agent session. This allowlist replaces that blanket spread.
 *
 * Inclusion rationale per entry is in the adjacent comment.
 */
const ALLOWED_EXACT: ReadonlySet<string> = new Set([
  // ── System ──────────────────────────────────────────────────────────────
  "PATH", // required to locate the provider binary and any tools it invokes
  "HOME", // config dir base for Claude (~/.claude), Codex (~/.codex), Cursor
  "SHELL", // some CLIs read SHELL to pick a default
  "TERM", // terminal type; Claude Code reads this for colour output decisions
  "USER", // username; some CLIs log or key on this
  "LOGNAME", // POSIX alias for USER
  "TMPDIR", // temp dir (macOS/Linux); used by child processes for scratch space
  "TEMP", // Windows temp dir
  "TMP", // Windows temp dir (legacy)
  "USERPROFILE", // Windows home-dir equivalent; replaces HOME on Windows
  "SYSTEMROOT", // Windows; needed by win32 shell=true spawns
  "COMSPEC", // Windows shell path
  // ── Display / GUI ───────────────────────────────────────────────────────
  "DISPLAY", // X11 display; Electron-based CLIs need this on Linux
  "WAYLAND_DISPLAY", // Wayland equivalent
  // ── SSH / git credential forwarding ─────────────────────────────────────
  "SSH_AUTH_SOCK", // agent socket; child git operations need it
  "SSH_AGENT_PID",
  // ── RTK tool rewrite (Claude adapter reads these from the env it receives) ─
  "GITS_RTK_BIN", // path to rtk binary; ClaudeRtkToolRewrite.resolveRtkBin()
  "RTK_BIN", // alias
  "GITS_RTK_REWRITE_TOOLS", // feature flag; ClaudeRtkToolRewrite checks this
  // ── Provider-specific ───────────────────────────────────────────────────
  // Codex: CODEX_HOME is injected explicitly by CodexSessionRuntime/CodexProvider
  // (overrides this allowlist anyway), but include it here so any user-set
  // CODEX_HOME in their shell also reaches codex when no explicit override is set.
  "CODEX_HOME",
]);

// Windows treats these names case-insensitively, and user shells commonly expose
// title-cased variants. Preserve the source spelling so the child receives exactly
// what the host supplied. If a synthetic source contains duplicates, the last entry
// wins in both spelling and value.
const CASE_INSENSITIVE_SYSTEM_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
]);

/**
 * Env var prefixes: any key whose name starts with one of these passes through.
 * ponytail: prefix list — availability over purity for this pass; unknown
 * sub-vars within a provider's namespace are included, external namespaces excluded.
 */
const ALLOWED_PREFIXES: ReadonlyArray<string> = [
  // System locale
  "LANG", // LANG and LANGUAGE
  "LC_", // LC_ALL, LC_CTYPE, etc.
  // XDG (Linux config/data/cache dirs; Claude Code and Codex respect these)
  "XDG_",
  // Node.js runtime (Claude Code and Codex are Node-based; children may need these)
  "NODE_", // NODE_PATH, NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, etc.
  // Bun runtime (if provider CLIs are built with Bun in future)
  "BUN_",
  // Claude / Anthropic — auth tokens, config overrides
  "ANTHROPIC_",
  "CLAUDE_",
  // Codex / OpenAI
  "OPENAI_",
  "CODEX_", // CODEX_HOME (exact above), CODEX_DISABLE_TELEMETRY, etc.
  // Cursor
  "CURSOR_",
  // OpenCode
  "OPENCODE_", // OPENCODE_CONFIG_CONTENT is injected explicitly but prefix is safe
];

/**
 * Build a sanitised copy of `source` containing only vars on the allowlist.
 * Explicit injections (CODEX_HOME, HOME override, etc.) are applied on top
 * by the callers — they always win regardless of this filter.
 *
 * ponytail: O(|source|) linear scan; server process.env is typically <100 keys.
 */
export function buildChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const systemKeySpellings = new Map<string, string>();
  for (const key of Object.keys(source)) {
    const normalizedKey = key.toUpperCase();
    if (CASE_INSENSITIVE_SYSTEM_KEYS.has(normalizedKey)) {
      const previousSpelling = systemKeySpellings.get(normalizedKey);
      if (previousSpelling !== undefined) {
        delete out[previousSpelling];
      }
      out[key] = source[key];
      systemKeySpellings.set(normalizedKey, key);
      continue;
    }
    if (ALLOWED_EXACT.has(key)) {
      out[key] = source[key];
      continue;
    }
    for (const prefix of ALLOWED_PREFIXES) {
      if (key.startsWith(prefix)) {
        out[key] = source[key];
        break;
      }
    }
  }
  return out;
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  // ponytail: W5.2b — default is now allowlisted, not raw process.env
  baseEnv: NodeJS.ProcessEnv = buildChildEnv(),
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}

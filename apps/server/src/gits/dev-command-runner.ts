// @effect-diagnostics nodeBuiltinImport:off
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

const RUNNER_FILENAME = "dev-command-runner.sh";
const RUNNER_SOURCE = `#!/usr/bin/env bash
set -euo pipefail

name="\${GITS_DEV_NAME:-Dev command}"
cwd="\${GITS_DEV_CWD:-}"
command_text="\${GITS_DEV_COMMAND:-}"
local_host="\${GITS_DEV_LOCAL_HOST:-127.0.0.1}"
local_port="\${GITS_DEV_LOCAL_PORT:-}"
allowed_hosts="\${GITS_DEV_ALLOWED_HOSTS:-}"
serve_port="\${GITS_DEV_SERVE_PORT:-}"

if [[ -z "\${cwd}" ]]; then
  echo "[gits-dev] GITS_DEV_CWD is required." >&2
  exit 64
fi

if [[ -z "\${command_text}" ]]; then
  echo "[gits-dev] GITS_DEV_COMMAND is required." >&2
  exit 64
fi

if [[ -n "\${local_port}" ]]; then
  if ! [[ "\${local_port}" =~ ^[0-9]+$ ]] || ((local_port < 1 || local_port > 65535)); then
    echo "[gits-dev] GITS_DEV_LOCAL_PORT must be between 1 and 65535." >&2
    exit 64
  fi
  if (exec 3<>"/dev/tcp/\${local_host}/\${local_port}") 2>/dev/null; then
    echo "[gits-dev] Port \${local_host}:\${local_port} is already in use; command was not started." >&2
    exit 78
  fi
fi

# Bind hint for frameworks that read HOST (webpack dev server, CRA, Remix, ...).
# Vite only honours --host, which gits appends to the command itself.
export HOST="\${local_host}"

if [[ -n "\${allowed_hosts}" ]]; then
  # Vite reads this without touching the project's vite.config.
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="\${allowed_hosts}"
  # Escape hatch: other frameworks (Next.js allowedDevOrigins, webpack
  # devServer.allowedHosts) can read GITS_DEV_ALLOWED_HOSTS from their own config.
  export GITS_DEV_ALLOWED_HOSTS="\${allowed_hosts}"
fi

serve_registered=0
if [[ -n "\${serve_port}" ]]; then
  if [[ -z "\${local_port}" ]]; then
    echo "[gits-dev] GITS_DEV_SERVE_PORT requires GITS_DEV_LOCAL_PORT." >&2
    exit 64
  fi
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "[gits-dev] tailscale not found; skipping tailnet publish." >&2
  elif tailscale serve --bg "--https=\${serve_port}" "http://\${local_host}:\${local_port}"; then
    serve_registered=1
    trap 'tailscale serve "--https='"\${serve_port}"'" off >/dev/null 2>&1 || true' EXIT
    echo "[gits-dev] Published on the tailnet at :\${serve_port}"
  else
    echo "[gits-dev] tailscale serve failed; continuing without tailnet publishing. Needs root or 'tailscale set --operator=$(whoami)'." >&2
  fi
fi

cd -- "\${cwd}"
echo "[gits-dev] Starting \${name} in \${cwd}"
if ((serve_registered)); then
  # Not exec: the EXIT trap has to survive to deregister the serve mapping.
  bash -lc "\${command_text}"
else
  exec bash -lc "\${command_text}"
fi
`;

const ALLOWED_HOST_PATTERN = /^[a-zA-Z0-9.*_-]+$/u;

/**
 * Parses a comma-separated string (env var) or array (config file) of allowed
 * hostnames. Vite's leading-dot wildcard (`.taild6d729.ts.net`) is preserved so a
 * single entry can cover an entire tailnet.
 */
export function parseAllowedHosts(
  value: string | ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> {
  const parts = typeof value === "string" ? value.split(",") : (value ?? []);
  return parts.map((part) => part.trim()).filter((part) => ALLOWED_HOST_PATTERN.test(part));
}

function shellArg(value: string): string {
  return /^[a-zA-Z0-9._:[\]-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

const DIRECT_VITE_RE = /^(?:(?:bunx|npx|pnpm exec|yarn dlx)\s+)?vite(?:\s|$)/u;
const SCRIPT_RUNNER_RE = /^(?:bun|npm|pnpm|yarn)\s+run\s+\S+/u;

export function withStrictPortArgs(input: {
  readonly command: string;
  readonly host: string;
  readonly port: number;
}): string {
  const command = input.command.trim();
  const isDirectVite = DIRECT_VITE_RE.test(command);
  // Package-manager wrappers forward everything after `--` to the underlying script.
  const isScriptRunner = !isDirectVite && SCRIPT_RUNNER_RE.test(command);
  if (!isDirectVite && !isScriptRunner) {
    return command;
  }

  let strictCommand = isScriptRunner && !command.includes(" -- ") ? `${command} --` : command;
  if (!/(?:^|\s)--host(?:=|\s|$)/u.test(strictCommand)) {
    strictCommand += ` --host ${shellArg(input.host)}`;
  }
  if (!/(?:^|\s)--port(?:=|\s|$)/u.test(strictCommand)) {
    strictCommand += ` --port ${input.port}`;
  }
  if (!/(?:^|\s)--strictPort(?:=|\s|$)/u.test(strictCommand)) {
    strictCommand += " --strictPort";
  }
  return strictCommand;
}

export async function materializeDevCommandRunner(stateDir: string): Promise<string> {
  const runnerDirectory = Path.join(stateDir, "gits");
  const runnerPath = Path.join(runnerDirectory, RUNNER_FILENAME);
  await Fs.mkdir(runnerDirectory, { recursive: true });
  await Fs.writeFile(runnerPath, RUNNER_SOURCE, { encoding: "utf8", mode: 0o700 });
  await Fs.chmod(runnerPath, 0o700);
  return runnerPath;
}

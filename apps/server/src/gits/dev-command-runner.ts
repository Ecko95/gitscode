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

cd -- "\${cwd}"
echo "[gits-dev] Starting \${name} in \${cwd}"
exec bash -lc "\${command_text}"
`;

function shellArg(value: string): string {
  return /^[a-zA-Z0-9._:[\]-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function withStrictPortArgs(input: {
  readonly command: string;
  readonly host: string;
  readonly port: number;
}): string {
  const command = input.command.trim();
  if (!/^(?:(?:bunx|npx|pnpm exec|yarn dlx)\s+)?vite(?:\s|$)/u.test(command)) {
    return command;
  }

  let strictCommand = command;
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

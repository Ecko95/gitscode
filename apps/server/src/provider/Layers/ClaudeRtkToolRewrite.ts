// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const SHELL_TOOL_NAME_SUFFIXES = ["bash", "shell", "terminal"] as const;
const COMMAND_FIELD_NAMES = ["command", "cmd"] as const;

export interface ClaudeRtkRewriteRunnerInput {
  readonly bin: string;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ClaudeRtkRewriteRunnerResult {
  readonly code: number | null;
  readonly stdout: string;
}

export type ClaudeRtkRewriteRunner = (
  input: ClaudeRtkRewriteRunnerInput,
) => Promise<ClaudeRtkRewriteRunnerResult>;

interface CommandRewriteCandidate {
  readonly commandField: (typeof COMMAND_FIELD_NAMES)[number];
  readonly command: string;
  readonly input: Record<string, unknown>;
}

function normalizeEnvFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_ENV_VALUES.has(value.trim().toLowerCase());
}

function isShellToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return SHELL_TOOL_NAME_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`),
  );
}

function getCommandRewriteCandidate(
  toolName: string,
  toolInput: unknown,
): CommandRewriteCandidate | undefined {
  if (!isShellToolName(toolName)) {
    return undefined;
  }

  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return undefined;
  }

  const input = toolInput as Record<string, unknown>;
  for (const commandField of COMMAND_FIELD_NAMES) {
    const rawCommand = input[commandField];
    if (typeof rawCommand === "string" && rawCommand.trim().length > 0) {
      return {
        commandField,
        command: rawCommand,
        input,
      };
    }
  }

  return undefined;
}

function resolveRtkBin(env: NodeJS.ProcessEnv): string {
  const configuredBin = env.GITS_RTK_BIN?.trim() || env.RTK_BIN?.trim();
  return configuredBin && configuredBin.length > 0 ? configuredBin : "rtk";
}

export const defaultClaudeRtkRewriteRunner: ClaudeRtkRewriteRunner = async ({
  bin,
  command,
  env,
}) =>
  await new Promise<ClaudeRtkRewriteRunnerResult>((resolve) => {
    execFile(
      bin,
      ["rewrite", command],
      {
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      },
      (error, stdout) => {
        if (!error) {
          resolve({
            code: 0,
            stdout,
          });
          return;
        }

        const code = typeof error.code === "number" ? error.code : null;
        resolve({
          code,
          stdout,
        });
      },
    );
  });

export async function rewriteClaudeToolInputWithRtkIfEnabled<T>(
  toolName: string,
  toolInput: T,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: ClaudeRtkRewriteRunner;
  },
): Promise<T> {
  const env = options?.env ?? process.env;
  if (!normalizeEnvFlag(env.GITS_RTK_REWRITE_TOOLS)) {
    return toolInput;
  }

  const candidate = getCommandRewriteCandidate(toolName, toolInput);
  if (!candidate) {
    return toolInput;
  }

  const run = options?.run ?? defaultClaudeRtkRewriteRunner;
  try {
    const result = await run({
      bin: resolveRtkBin(env),
      command: candidate.command,
      env,
    });
    const rewrittenCommand = result.code === 0 ? result.stdout.trim() : "";
    if (rewrittenCommand.length === 0) {
      return toolInput;
    }

    return {
      ...candidate.input,
      [candidate.commandField]: rewrittenCommand,
    } as T;
  } catch {
    return toolInput;
  }
}

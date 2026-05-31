import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import {
  OpenGsdAdapterError,
  type OpenGsdCapability,
  type OpenGsdCommandName,
  type OpenGsdCommandResult,
  type OpenGsdCommandStatus,
  type OpenGsdStatusResult,
} from "@t3tools/contracts";

import { OpenGsdAdapter, type OpenGsdAdapterShape } from "../Services/OpenGsdAdapter.ts";
import {
  ProcessOutputLimitError,
  ProcessReadError,
  ProcessRunner,
  ProcessSpawnError,
  ProcessStdinError,
  ProcessTimeoutError,
  isWindowsCommandNotFound,
  layer as ProcessRunnerLive,
  type ProcessRunError,
} from "../../processRunner.ts";

const PACKAGE_NAME = "@opengsd/get-shit-done-redux";
const CLI_NAME = "gsd-sdk";
const ALL_CAPABILITIES: ReadonlyArray<OpenGsdCapability> = ["detect", "init", "auto"];
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

function toOpenGsdError(message: string, cause?: unknown) {
  return new OpenGsdAdapterError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function resolveBinaryPath() {
  return process.env.GITS_GSD_SDK_BIN?.trim() || process.env.GSD_SDK_BIN?.trim() || CLI_NAME;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function isCommandMissing(cause: unknown): boolean {
  return errorText(cause).toLowerCase().includes("enoent");
}

function openGsdFailureMessage(cause: ProcessRunError): string {
  if (cause instanceof ProcessSpawnError && isCommandMissing(cause.cause)) {
    return "Open GSD command failed. Confirm `gsd-sdk` is installed and on PATH.";
  }

  if (cause instanceof ProcessTimeoutError) {
    return `Open GSD command timed out after ${cause.timeoutMs}ms.`;
  }

  if (cause instanceof ProcessOutputLimitError) {
    return `Open GSD command output exceeded ${cause.maxBytes} bytes.`;
  }

  if (cause instanceof ProcessReadError) {
    return `Open GSD command failed while reading ${cause.stream}.`;
  }

  if (cause instanceof ProcessStdinError) {
    return "Open GSD command failed while writing stdin.";
  }

  return "Open GSD command failed.";
}

function execOpenGsd(
  processRunner: ProcessRunner["Service"],
  args: ReadonlyArray<string>,
  options?: {
    readonly cwd?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly outputMode?: "error" | "truncate" | undefined;
    readonly timeoutBehavior?: "error" | "timedOutResult" | undefined;
  },
) {
  const binaryPath = resolveBinaryPath();
  return processRunner
    .run({
      command: binaryPath,
      args,
      ...(options?.cwd ? { cwd: options.cwd } : {}),
      timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: options?.outputMode ?? "error",
      truncatedMarker: options?.outputMode === "truncate" ? OUTPUT_TRUNCATED_MARKER : "",
      timeoutBehavior: options?.timeoutBehavior ?? "error",
      shell: process.platform === "win32",
    })
    .pipe(
      Effect.flatMap((result) => {
        if (isWindowsCommandNotFound(result.code, result.stderr)) {
          return Effect.fail(
            toOpenGsdError("Open GSD command failed. Confirm `gsd-sdk` is installed and on PATH."),
          );
        }

        return Effect.succeed({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          signal: null,
          timedOut: result.timedOut,
        } satisfies ExecResult);
      }),
      Effect.mapError((cause) =>
        cause instanceof OpenGsdAdapterError
          ? cause
          : toOpenGsdError(openGsdFailureMessage(cause), cause),
      ),
    );
}

function parseVersionOutput(stdout: string): string | null {
  const version = stdout.match(/\bv?\d+\.\d+\.\d+(?:[-+][^\s]+)?\b/)?.[0] ?? null;
  return version ?? (stdout.trim().length > 0 ? stdout.trim() : null);
}

function capabilitySnapshot(input: {
  readonly helpText: string | null;
  readonly version: string | null;
  readonly checkedAt: string;
}): OpenGsdStatusResult {
  const supported = new Set<OpenGsdCapability>();
  if (input.helpText !== null) {
    supported.add("detect");
    if (/\binit\b/.test(input.helpText)) supported.add("init");
    if (/\bauto\b/.test(input.helpText)) supported.add("auto");
  }

  return {
    available: input.helpText !== null,
    binaryPath: resolveBinaryPath(),
    packageName: PACKAGE_NAME,
    cliName: CLI_NAME,
    version: input.version,
    supported: ALL_CAPABILITIES.filter((capability) => supported.has(capability)),
    unsupported: ALL_CAPABILITIES.filter((capability) => !supported.has(capability)),
    checkedAt: input.checkedAt,
  };
}

function getStatus(processRunner: ProcessRunner["Service"]) {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const result = yield* Effect.all({
      help: execOpenGsd(processRunner, ["--help"]).pipe(Effect.result),
      version: execOpenGsd(processRunner, ["--version"]).pipe(Effect.result),
    });

    const helpText = Result.isSuccess(result.help) ? result.help.success.stdout : null;
    const version = Result.isSuccess(result.version)
      ? parseVersionOutput(result.version.success.stdout)
      : null;

    return capabilitySnapshot({ helpText, version, checkedAt });
  });
}

function appendCommonArgs(
  args: string[],
  input: {
    readonly projectDir: string;
    readonly workstream?: string | undefined;
    readonly model?: string | undefined;
    readonly maxBudgetUsd?: number | undefined;
  },
) {
  args.push("--project-dir", input.projectDir);
  if (input.workstream) args.push("--ws", input.workstream);
  if (input.model) args.push("--model", input.model);
  if (input.maxBudgetUsd !== undefined) args.push("--max-budget", String(input.maxBudgetUsd));
}

function initArgs(input: Parameters<OpenGsdAdapterShape["initProject"]>[0]): string[] {
  const args = ["init", input.input];
  appendCommonArgs(args, input);
  return args;
}

function autoArgs(input: Parameters<OpenGsdAdapterShape["runAuto"]>[0]): string[] {
  const args = ["auto"];
  if (input.initInput) args.push("--init", input.initInput);
  appendCommonArgs(args, input);
  return args;
}

function statusFromResult(result: ExecResult): OpenGsdCommandStatus {
  if (result.timedOut) {
    return "timed-out";
  }
  return result.exitCode === 0 ? "completed" : "failed";
}

function runCommand(
  processRunner: ProcessRunner["Service"],
  command: OpenGsdCommandName,
  projectDir: string,
  args: ReadonlyArray<string>,
  timeoutMs: number | undefined,
) {
  return Effect.gen(function* () {
    const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const startedMs = yield* Clock.currentTimeMillis;
    const result = yield* execOpenGsd(
      processRunner,
      args,
      timeoutMs === undefined
        ? {
            cwd: projectDir,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          }
        : {
            cwd: projectDir,
            timeoutMs,
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          },
    );
    const finishedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const finishedMs = yield* Clock.currentTimeMillis;

    return {
      command,
      projectDir,
      status: statusFromResult(result),
      args: [...args],
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedMs - startedMs),
    } satisfies OpenGsdCommandResult;
  });
}

export const makeOpenGsdCliAdapter = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner;

  return {
    getStatus: () => getStatus(processRunner),
    initProject: (input) =>
      runCommand(processRunner, "init", input.projectDir, initArgs(input), input.timeoutMs),
    runAuto: (input) =>
      runCommand(processRunner, "auto", input.projectDir, autoArgs(input), input.timeoutMs),
  } satisfies OpenGsdAdapterShape;
});

export const OpenGsdCliAdapterLive = Layer.effect(OpenGsdAdapter, makeOpenGsdCliAdapter).pipe(
  Layer.provide(ProcessRunnerLive),
);

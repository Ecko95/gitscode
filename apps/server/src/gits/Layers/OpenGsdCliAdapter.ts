// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";

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

const PACKAGE_NAME = "@opengsd/get-shit-done-redux";
const CLI_NAME = "gsd-sdk";
const ALL_CAPABILITIES: ReadonlyArray<OpenGsdCapability> = ["detect", "init", "auto"];
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

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

function errorExitCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function errorSignal(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("signal" in error)) {
    return null;
  }
  const signal = (error as { readonly signal?: unknown }).signal;
  return typeof signal === "string" && signal.trim().length > 0 ? signal.trim() : null;
}

function errorTimedOut(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("killed" in error && (error as { readonly killed?: unknown }).killed === true) {
    return true;
  }
  return errorSignal(error) === "SIGTERM";
}

function execOpenGsd(args: ReadonlyArray<string>, options?: { cwd?: string; timeoutMs?: number }) {
  const binaryPath = resolveBinaryPath();
  return Effect.tryPromise({
    try: () =>
      new Promise<ExecResult>((resolve, reject) => {
        execFile(
          binaryPath,
          [...args],
          {
            cwd: options?.cwd,
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({
                stdout,
                stderr,
                exitCode: 0,
                signal: null,
                timedOut: false,
              });
              return;
            }

            const exitCode = errorExitCode(error);
            if (exitCode !== null || errorSignal(error) !== null) {
              resolve({
                stdout,
                stderr,
                exitCode,
                signal: errorSignal(error),
                timedOut: errorTimedOut(error),
              });
              return;
            }

            reject({ error, stderr, stdout });
          },
        );
      }),
    catch: (cause) => {
      const detail =
        typeof cause === "object" && cause !== null && "stderr" in cause
          ? String((cause as { readonly stderr?: unknown }).stderr ?? "").trim()
          : "";
      return toOpenGsdError(
        detail.length > 0
          ? `Open GSD command failed: ${detail}`
          : "Open GSD command failed. Confirm `gsd-sdk` is installed and on PATH.",
        cause,
      );
    },
  });
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

function getStatus() {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const result = yield* Effect.all({
      help: execOpenGsd(["--help"]).pipe(Effect.result),
      version: execOpenGsd(["--version"]).pipe(Effect.result),
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
  command: OpenGsdCommandName,
  projectDir: string,
  args: ReadonlyArray<string>,
  timeoutMs: number | undefined,
) {
  return Effect.gen(function* () {
    const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const startedMs = yield* Clock.currentTimeMillis;
    const result = yield* execOpenGsd(
      args,
      timeoutMs === undefined ? { cwd: projectDir } : { cwd: projectDir, timeoutMs },
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

const makeOpenGsdCliAdapterShape: OpenGsdAdapterShape = {
  getStatus,
  initProject: (input) => runCommand("init", input.projectDir, initArgs(input), input.timeoutMs),
  runAuto: (input) => runCommand("auto", input.projectDir, autoArgs(input), input.timeoutMs),
};

export const makeOpenGsdCliAdapter = Effect.succeed(makeOpenGsdCliAdapterShape);

export const OpenGsdCliAdapterLive = Layer.effect(OpenGsdAdapter, makeOpenGsdCliAdapter);

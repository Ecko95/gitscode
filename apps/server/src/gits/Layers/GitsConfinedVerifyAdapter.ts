import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import {
  GitsVerificationGateError,
  type GitsVerifyCommandResult,
  type GitsVerifyInput,
  type GitsVerifyResult,
} from "@t3tools/contracts";

import {
  GitsVerificationGate,
  type GitsVerificationGateShape,
} from "../Services/GitsVerificationGate.ts";
import { ProcessRunner, layer as ProcessRunnerLive } from "../../processRunner.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TRUNCATED_MARKER = "\n\n[truncated]";
const OUTPUT_TAIL_CHARS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

function toGateError(message: string, cause?: unknown) {
  return new GitsVerificationGateError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

// scripts/gits-confine.sh — operators set GITS_CONFINE_BIN to an absolute path, or put it on PATH.
function resolveConfineBin(): string {
  return process.env.GITS_CONFINE_BIN?.trim() || "gits-confine.sh";
}

function execProcess(
  processRunner: ProcessRunner["Service"],
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
) {
  return processRunner
    .run({
      command,
      args,
      cwd,
      timeout: timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: "truncate",
      truncatedMarker: TRUNCATED_MARKER,
      timeoutBehavior: "timedOutResult",
      shell: false,
    })
    .pipe(
      Effect.map(
        (r) =>
          ({
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.code,
            timedOut: r.timedOut,
          }) satisfies ExecResult,
      ),
      Effect.mapError((cause) =>
        toGateError(
          `Confined verification failed to execute \`${command}\`. Confirm the confine wrapper (GITS_CONFINE_BIN) and bwrap are installed.`,
          cause,
        ),
      ),
    );
}

// True only when `bwrap --version` runs and exits 0. Never fails the effect.
function probeBwrap(processRunner: ProcessRunner["Service"]) {
  return processRunner
    .run({
      command: "bwrap",
      args: ["--version"],
      timeout: PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
      truncatedMarker: "",
      timeoutBehavior: "timedOutResult",
      shell: false,
    })
    .pipe(
      Effect.result,
      Effect.map((r) => Result.isSuccess(r) && r.success.code === 0 && !r.success.timedOut),
    );
}

function run(processRunner: ProcessRunner["Service"], input: GitsVerifyInput) {
  return Effect.gen(function* () {
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const requireConfinement = input.requireConfinement ?? true;
    const confined = yield* probeBwrap(processRunner);

    if (!confined && requireConfinement) {
      return yield* toGateError(
        "Confinement unavailable: `bwrap` was not found or did not run, and requireConfinement is set. Refusing to run untrusted verification on the host (H0).",
      );
    }

    const confineBin = resolveConfineBin();
    const results: GitsVerifyCommandResult[] = [];

    for (const entry of input.commands) {
      const [head = "", ...rest] = entry.cmd;
      if (head === "") continue;
      const timeoutMs = (entry.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_MS / 1000) * 1000;

      const command = confined ? confineBin : head;
      const args = confined
        ? [
            "--worktree",
            input.worktree,
            "--profile",
            "verify",
            "--label",
            entry.label,
            "--",
            head,
            ...rest,
          ]
        : rest;

      const startedMs = yield* Clock.currentTimeMillis;
      const exec = yield* execProcess(processRunner, command, args, input.worktree, timeoutMs);
      const finishedMs = yield* Clock.currentTimeMillis;

      const tailSource = (exec.stderr.trim().length > 0 ? exec.stderr : exec.stdout) ?? "";
      results.push({
        label: entry.label,
        passed: exec.exitCode === 0 && !exec.timedOut,
        exitCode: exec.exitCode,
        timedOut: exec.timedOut,
        durationMs: Math.max(0, finishedMs - startedMs),
        outputTail: tailSource.slice(-OUTPUT_TAIL_CHARS) || "(no output)",
      });
    }

    return {
      worktree: input.worktree,
      confined,
      passed: results.every((r) => r.passed),
      results,
      checkedAt,
    } satisfies GitsVerifyResult;
  });
}

export const makeGitsConfinedVerifyAdapter = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner;
  return {
    run: (input) => run(processRunner, input),
  } satisfies GitsVerificationGateShape;
});

export const GitsConfinedVerifyAdapterLive = Layer.effect(
  GitsVerificationGate,
  makeGitsConfinedVerifyAdapter,
).pipe(Layer.provide(ProcessRunnerLive));

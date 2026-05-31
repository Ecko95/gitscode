import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_RTK_TIMEOUT = "10 seconds";
const MAX_RTK_OUTPUT_BYTES = 8 * 1024 * 1024;
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export interface RtkSettings {
  readonly binaryPath: string;
  readonly outputGatewayEnabled: boolean;
  readonly rewriteToolsEnabled: boolean;
  readonly ultraCompact: boolean;
}

export interface RtkGatewayStatus extends RtkSettings {
  readonly enabled: boolean;
  readonly available: boolean;
}

export interface RtkRewriteResult {
  readonly command: string;
  readonly rewritten: boolean;
}

export interface RtkPipeInput {
  readonly filter: string;
  readonly text: string;
}

export interface RtkCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
}

export interface RtkCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: ChildProcessSpawner.ExitCode | null;
  readonly timedOut: boolean;
}

export class RtkGatewayCommandError extends Data.TaggedError("RtkGatewayCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RtkGatewayOutputLimitError extends Data.TaggedError("RtkGatewayOutputLimitError")<{
  readonly maxBytes: number;
}> {}

export class RtkGatewayTimeoutError extends Data.TaggedError("RtkGatewayTimeoutError")<{
  readonly timeout: Duration.Input;
}> {}

export type RtkCommandError =
  | RtkGatewayCommandError
  | RtkGatewayOutputLimitError
  | RtkGatewayTimeoutError;

export type RtkCommandRunner = (
  input: RtkCommandInput,
) => Effect.Effect<RtkCommandResult, RtkCommandError>;

export interface MakeRtkGatewayOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly runCommand?: RtkCommandRunner | undefined;
}

export interface RtkGatewayShape {
  readonly getStatus: Effect.Effect<RtkGatewayStatus>;
  readonly rewriteCommand: (rawCommand: string) => Effect.Effect<RtkRewriteResult>;
  readonly pipeText: (input: RtkPipeInput) => Effect.Effect<string>;
}

export class RtkGateway extends Context.Service<RtkGateway, RtkGatewayShape>()(
  "t3/rtk/RtkGateway",
) {}

function nonEmptyString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = nonEmptyString(value)?.toLowerCase();
  return normalized ? TRUTHY_ENV_VALUES.has(normalized) : false;
}

export function resolveRtkSettings(env: NodeJS.ProcessEnv = process.env): RtkSettings {
  return {
    binaryPath: nonEmptyString(env.GITS_RTK_BIN) ?? nonEmptyString(env.RTK_BIN) ?? "rtk",
    outputGatewayEnabled: envFlagEnabled(env.GITS_RTK_OUTPUT_GATEWAY),
    rewriteToolsEnabled: envFlagEnabled(env.GITS_RTK_REWRITE_TOOLS),
    ultraCompact: envFlagEnabled(env.GITS_RTK_ULTRA_COMPACT),
  };
}

const collectText = Effect.fn("RtkGateway.collectText")(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
) {
  const collected = yield* stream.pipe(
    Stream.mapError(
      (cause) =>
        new RtkGatewayCommandError({
          message: "RTK output read failed.",
          cause,
        }),
    ),
    Stream.runFoldEffect<
      {
        readonly chunks: Uint8Array[];
        readonly bytes: number;
      },
      Uint8Array,
      RtkGatewayCommandError | RtkGatewayOutputLimitError,
      never
    >(
      () => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        const nextBytes = state.bytes + chunk.byteLength;
        if (nextBytes > MAX_RTK_OUTPUT_BYTES) {
          return Effect.fail(
            new RtkGatewayOutputLimitError({
              maxBytes: MAX_RTK_OUTPUT_BYTES,
            }),
          );
        }

        state.chunks.push(chunk);
        return Effect.succeed({
          chunks: state.chunks,
          bytes: nextBytes,
        });
      },
    ),
  );

  return Buffer.concat(collected.chunks, collected.bytes).toString("utf8");
});

const makeChildProcessCommandRunner = Effect.fn("RtkGateway.makeChildProcessCommandRunner")(
  function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const runCommand: RtkCommandRunner = (input) =>
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(input.command, [...input.args], {
              shell: false,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new RtkGatewayCommandError({
                  message: "RTK command spawn failed.",
                  cause,
                }),
            ),
          );

        const writeStdin =
          input.stdin === undefined
            ? Effect.void
            : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                Effect.mapError(
                  (cause) =>
                    new RtkGatewayCommandError({
                      message: "RTK stdin write failed.",
                      cause,
                    }),
                ),
              );

        const [stdout, stderr] = yield* Effect.all(
          [collectText(child.stdout), collectText(child.stderr), writeStdin],
          { concurrency: "unbounded" },
        );

        const exitCode = yield* child.exitCode.pipe(
          Effect.mapError(
            (cause) =>
              new RtkGatewayCommandError({
                message: "RTK exit code read failed.",
                cause,
              }),
          ),
        );

        return {
          stdout,
          stderr,
          code: exitCode,
          timedOut: false,
        } satisfies RtkCommandResult;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(Duration.fromInputUnsafe(input.timeout ?? DEFAULT_RTK_TIMEOUT)),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new RtkGatewayTimeoutError({
                  timeout: input.timeout ?? DEFAULT_RTK_TIMEOUT,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

    return runCommand;
  },
);

function isRewriteDeclined(rawCommand: string, output: string): boolean {
  const normalizedOutput = output.trim();
  if (normalizedOutput.length === 0) return true;
  if (normalizedOutput.includes("\n") || normalizedOutput.includes("\r")) return true;
  return normalizedOutput === rawCommand.trim();
}

function pipeArgs(settings: RtkSettings, filter: string): ReadonlyArray<string> {
  return settings.ultraCompact ? ["pipe", "-f", filter, "--ultra-compact"] : ["pipe", "-f", filter];
}

function isCommandAvailable(
  runCommand: RtkCommandRunner,
  settings: RtkSettings,
): Effect.Effect<boolean> {
  return runCommand({
    command: settings.binaryPath,
    args: ["--version"],
    timeout: "2 seconds",
  }).pipe(
    Effect.map((result) => result.code === 0 && !result.timedOut),
    Effect.catchCause(() => Effect.succeed(false)),
  );
}

export const makeRtkGateway = Effect.fn("makeRtkGateway")(function* (
  options: MakeRtkGatewayOptions = {},
) {
  const settings = resolveRtkSettings(options.env);
  const enabled = settings.outputGatewayEnabled || settings.rewriteToolsEnabled;
  const runCommand =
    options.runCommand !== undefined ? options.runCommand : yield* makeChildProcessCommandRunner();

  const getStatus = Effect.suspend(() => isCommandAvailable(runCommand, settings)).pipe(
    Effect.map(
      (available): RtkGatewayStatus => ({
        ...settings,
        enabled,
        available,
      }),
    ),
  );

  const rewriteCommand: RtkGatewayShape["rewriteCommand"] = Effect.fn("RtkGateway.rewriteCommand")(
    function* (rawCommand: string) {
      const normalizedCommand = rawCommand.trim();
      if (!settings.rewriteToolsEnabled || normalizedCommand.length === 0) {
        return {
          command: rawCommand,
          rewritten: false,
        } satisfies RtkRewriteResult;
      }

      const result = yield* runCommand({
        command: settings.binaryPath,
        args: ["rewrite", rawCommand],
      }).pipe(Effect.catchCause(() => Effect.succeed<RtkCommandResult | null>(null)));

      if (
        result === null ||
        result.timedOut ||
        result.code !== 0 ||
        isRewriteDeclined(rawCommand, result.stdout)
      ) {
        return {
          command: rawCommand,
          rewritten: false,
        } satisfies RtkRewriteResult;
      }

      return {
        command: result.stdout.trim(),
        rewritten: true,
      } satisfies RtkRewriteResult;
    },
  );

  const pipeText: RtkGatewayShape["pipeText"] = Effect.fn("RtkGateway.pipeText")(function* (
    input: RtkPipeInput,
  ) {
    const filter = input.filter.trim();
    if (!settings.outputGatewayEnabled || filter.length === 0 || input.text.length === 0) {
      return input.text;
    }

    const result = yield* runCommand({
      command: settings.binaryPath,
      args: pipeArgs(settings, filter),
      stdin: input.text,
    }).pipe(Effect.catchCause(() => Effect.succeed<RtkCommandResult | null>(null)));

    if (result === null || result.timedOut || result.code !== 0) {
      return input.text;
    }

    return result.stdout;
  });

  return RtkGateway.of({
    getStatus,
    rewriteCommand,
    pipeText,
  });
});

export const layer = Layer.effect(RtkGateway, makeRtkGateway());

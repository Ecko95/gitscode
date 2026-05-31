import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DelamainAdapterError,
  type DelamainCapabilities,
  type DelamainCapability,
  type DelamainEngine,
  type DelamainPeer,
  type DelamainPeerIntegrateResult,
  type DelamainPeerListResult,
  type DelamainPeerLogResult,
  type PeerStatus,
} from "@t3tools/contracts";

import { DelamainAdapter, type DelamainAdapterShape } from "../Services/DelamainAdapter.ts";
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

const ALL_CAPABILITIES: ReadonlyArray<DelamainCapability> = [
  "list",
  "status",
  "log",
  "spawn",
  "kill",
  "reply",
  "wait",
  "integrate",
];

const DEFAULT_LOG_LINES = 160;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const COMMAND_TIMEOUT_MS = 30_000;
const TERMINAL_STATUSES = new Set<PeerStatus>([
  "done",
  "completed",
  "failed",
  "frozen",
  "killed",
  "halted",
]);

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function toDelamainError(message: string, cause?: unknown) {
  return new DelamainAdapterError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function resolveBinaryPath() {
  return process.env.GITS_DELAMAIN_BIN?.trim() || process.env.DELAMAIN_BIN?.trim() || "delamain";
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function isCommandMissing(cause: unknown): boolean {
  return errorText(cause).toLowerCase().includes("enoent");
}

function commandOutputDetail(result: ExecResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }

  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    return stdout;
  }

  return result.exitCode === null
    ? "Delamain command failed."
    : `Delamain command exited with code ${result.exitCode}.`;
}

function delamainFailureMessage(cause: ProcessRunError): string {
  if (cause instanceof ProcessSpawnError && isCommandMissing(cause.cause)) {
    return "Delamain command failed. Confirm `delamain` is installed and on PATH.";
  }

  if (cause instanceof ProcessTimeoutError) {
    return `Delamain command timed out after ${cause.timeoutMs}ms.`;
  }

  if (cause instanceof ProcessOutputLimitError) {
    return `Delamain command output exceeded ${cause.maxBytes} bytes.`;
  }

  if (cause instanceof ProcessReadError) {
    return `Delamain command failed while reading ${cause.stream}.`;
  }

  if (cause instanceof ProcessStdinError) {
    return "Delamain command failed while writing stdin.";
  }

  return "Delamain command failed.";
}

function execDelamain(
  processRunner: ProcessRunner["Service"],
  args: ReadonlyArray<string>,
  options?: {
    readonly timeoutMs?: number | undefined;
    readonly outputMode?: "error" | "truncate" | undefined;
  },
) {
  const binaryPath = resolveBinaryPath();
  return processRunner
    .run({
      command: binaryPath,
      args,
      timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      outputMode: options?.outputMode ?? "error",
      truncatedMarker: options?.outputMode === "truncate" ? OUTPUT_TRUNCATED_MARKER : "",
      shell: process.platform === "win32",
    })
    .pipe(
      Effect.flatMap((result) => {
        if (isWindowsCommandNotFound(result.code, result.stderr)) {
          return Effect.fail(
            toDelamainError(
              "Delamain command failed. Confirm `delamain` is installed and on PATH.",
            ),
          );
        }

        const normalized = {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
        } satisfies ExecResult;

        if (result.code !== 0) {
          return Effect.fail(
            toDelamainError(`Delamain command failed: ${commandOutputDetail(normalized)}`),
          );
        }

        return Effect.succeed(normalized);
      }),
      Effect.mapError((cause) =>
        cause instanceof DelamainAdapterError
          ? cause
          : toDelamainError(delamainFailureMessage(cause), cause),
      ),
    );
}

function parseJson<T>(operation: string, stdout: string): Effect.Effect<T, DelamainAdapterError> {
  return Effect.try({
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    try: () => JSON.parse(stdout) as T,
    catch: (cause) => toDelamainError(`Delamain returned invalid JSON for ${operation}.`, cause),
  });
}

function runJson<T>(
  processRunner: ProcessRunner["Service"],
  operation: string,
  args: ReadonlyArray<string>,
) {
  return execDelamain(processRunner, args).pipe(
    Effect.flatMap((result) => parseJson<T>(operation, result.stdout)),
  );
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function summaryString(value: unknown): string | null {
  const text = nullableString(value);
  return text && text.length > 10_000 ? `${text.slice(0, 9_997)}...` : text;
}

function rawStatus(value: unknown): string {
  return nullableString(value) ?? "unknown";
}

function normalizeStatus(value: unknown): PeerStatus {
  const status = rawStatus(value).toLowerCase();
  if (status === "done") return "done";
  if (status === "completed" || status === "complete") return "completed";
  if (status === "running") return "running";
  if (status === "pending" || status === "queued" || status === "starting") return "pending";
  if (status === "waiting") return "waiting";
  if (status === "blocked") return "blocked";
  if (status === "failed" || status === "error") return "failed";
  if (status === "frozen") return "frozen";
  if (status === "killed") return "killed";
  if (status === "halted") return "halted";
  return "unknown";
}

function normalizeEngine(value: unknown): DelamainEngine {
  const engine = nullableString(value)?.toLowerCase();
  return engine === "codex" || engine === "cursor" ? engine : "unknown";
}

function rawRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizePeer(value: unknown): DelamainPeer {
  const peer = rawRecord(value);
  const id = nullableString(peer.id) ?? "unknown";
  const rawPeerStatus = rawStatus(peer.status);
  return {
    id,
    name: nullableString(peer.name),
    engine: normalizeEngine(peer.engine),
    model: nullableString(peer.model),
    status: normalizeStatus(rawPeerStatus),
    rawStatus: rawPeerStatus,
    integrationStatus: nullableString(peer.integrationStatus),
    sourceRepo: nullableString(peer.sourceRepo),
    worktreePath: nullableString(peer.worktreePath ?? peer.repo),
    branch: nullableString(peer.branch),
    baseBranch: nullableString(peer.baseBranch),
    mergeBranch: nullableString(peer.mergeBranch),
    prUrl: nullableString(peer.prUrl),
    task: summaryString(peer.task),
    lastEvent: summaryString(peer.lastEvent),
    startedAt: nullableString(peer.startedAt),
    updatedAt: nullableString(peer.updatedAt),
    finishedAt: nullableString(peer.finishedAt),
  };
}

function capabilitySnapshot(helpText: string | null, checkedAt: string): DelamainCapabilities {
  const supported = new Set<DelamainCapability>();
  if (helpText !== null) {
    if (/\blist\b/.test(helpText)) supported.add("list");
    if (/\bstatus\b/.test(helpText)) supported.add("status");
    if (/\blog\b/.test(helpText)) supported.add("log");
    if (/\bspawn\b/.test(helpText)) supported.add("spawn");
    if (/\bkill\b/.test(helpText)) supported.add("kill");
    if (/\bresume\b/.test(helpText)) supported.add("reply");
    if (supported.has("status")) supported.add("wait");
    if (/\bintegrate\b/.test(helpText)) supported.add("integrate");
  }

  return {
    available: helpText !== null,
    binaryPath: resolveBinaryPath(),
    supported: ALL_CAPABILITIES.filter((capability) => supported.has(capability)),
    unsupported: ALL_CAPABILITIES.filter((capability) => !supported.has(capability)),
    checkedAt,
  };
}

function readCapabilities(processRunner: ProcessRunner["Service"], checkedAt: string) {
  return execDelamain(processRunner, ["--help"]).pipe(
    Effect.map((result) => capabilitySnapshot(result.stdout, checkedAt)),
    Effect.catch(() => Effect.succeed(capabilitySnapshot(null, checkedAt))),
  );
}

function spawnArgs(input: Parameters<DelamainAdapterShape["spawnPeer"]>[0]): string[] {
  const args = ["spawn", "--repo", input.repo, "--prompt", input.prompt];
  if (input.name) args.push("--name", input.name);
  if (input.startRef) args.push("--start-ref", input.startRef);
  if (input.mergeBranch) args.push("--merge-branch", input.mergeBranch);
  if (input.targetBranch) args.push("--target-branch", input.targetBranch);
  if (input.engine && input.engine !== "unknown") args.push("--engine", input.engine);
  if (input.model) args.push("--model", input.model);
  if (input.sandbox) args.push("--sandbox", input.sandbox);
  if (input.yolo) args.push("--yolo");
  return args;
}

function replyArgs(input: Parameters<DelamainAdapterShape["sendPeerReply"]>[0]): string[] {
  const args = ["resume", input.peerId, "--prompt", input.prompt];
  if (input.model) args.push("--model", input.model);
  if (input.yolo) args.push("--yolo");
  return args;
}

export const makeDelamainCliAdapter = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner;

  const adapter: DelamainAdapterShape = {
    listPeers: () =>
      Effect.gen(function* () {
        const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const [capabilities, peers] = yield* Effect.all([
          readCapabilities(processRunner, checkedAt),
          runJson<unknown[]>(processRunner, "list", ["list"]),
        ]);
        return {
          capabilities,
          peers: peers.map(normalizePeer),
        } satisfies DelamainPeerListResult;
      }),
    getPeerStatus: (input) =>
      runJson<unknown>(processRunner, "status", ["status", input.peerId]).pipe(
        Effect.map(normalizePeer),
      ),
    readPeerLog: (input) => {
      const lines = input.lines ?? DEFAULT_LOG_LINES;
      return execDelamain(processRunner, ["log", input.peerId, String(lines)], {
        outputMode: "truncate",
      }).pipe(
        Effect.map(
          (result) =>
            ({
              peerId: input.peerId,
              lines,
              text: result.stdout,
            }) satisfies DelamainPeerLogResult,
        ),
      );
    },
    spawnPeer: (input) =>
      runJson<unknown>(processRunner, "spawn", spawnArgs(input)).pipe(Effect.map(normalizePeer)),
    killPeer: (input) =>
      runJson<unknown>(processRunner, "kill", [
        "kill",
        input.peerId,
        input.signal ?? "SIGTERM",
      ]).pipe(Effect.map(normalizePeer)),
    sendPeerReply: (input) =>
      runJson<unknown>(processRunner, "resume", replyArgs(input)).pipe(Effect.map(normalizePeer)),
    waitForPeer: (input) =>
      Effect.gen(function* () {
        const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const startedAt = yield* Clock.currentTimeMillis;
        const deadline = startedAt + timeoutMs;

        while (true) {
          const peer = yield* adapter.getPeerStatus({ peerId: input.peerId });
          if (TERMINAL_STATUSES.has(peer.status)) {
            return peer;
          }

          const now = yield* Clock.currentTimeMillis;
          if (now >= deadline) {
            return yield* toDelamainError(`Timed out waiting for peer ${input.peerId}.`);
          }

          yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
        }
      }),
    integratePeer: (input) =>
      runJson<unknown>(processRunner, "integrate", ["integrate", input.peerId]).pipe(
        Effect.map((value) => {
          const record = rawRecord(value);
          const peer = normalizePeer(record.peer ?? record);
          return {
            peer,
            prNumber:
              typeof record.pr_number === "number"
                ? record.pr_number
                : typeof record.prNumber === "number"
                  ? record.prNumber
                  : null,
            prUrl: nullableString(record.pr_url ?? record.prUrl),
            autoMergeEnabled: Boolean(record.auto_merge_enabled ?? record.autoMergeEnabled),
          } satisfies DelamainPeerIntegrateResult;
        }),
      ),
  };

  return adapter;
});

export const DelamainCliAdapterLive = Layer.effect(DelamainAdapter, makeDelamainCliAdapter).pipe(
  Layer.provide(ProcessRunnerLive),
);

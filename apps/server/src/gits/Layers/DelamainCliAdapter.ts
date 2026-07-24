import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  DelamainAdapterError,
  type DelamainCapabilities,
  type DelamainCapability,
  type DelamainEngine,
  type DelamainInboxResult,
  type DelamainMessage,
  type DelamainPeer,
  type DelamainPeerIntegrateResult,
  type DelamainPeerListResult,
  type DelamainPeerLogResult,
  type DelamainPeerLogParsedResult,
  type DelamainRunWorkflowResult,
  type ParsedLogEvent,
  type DelamainSendMessageResult,
  type DelamainWorkflowStatus,
  type DelamainWorkflowKillResult,
  type DelamainWorkflowRunResult,
  type PeerStatus,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
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
const isDelamainAdapterError = Schema.is(DelamainAdapterError);
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
    readonly environment?: NodeJS.ProcessEnv | undefined;
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
      env: options?.environment,
      extendEnv: options?.environment === undefined ? undefined : false,
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
        isDelamainAdapterError(cause)
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
  environment?: NodeJS.ProcessEnv,
) {
  return execDelamain(processRunner, args, { environment }).pipe(
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
  if (input.confine) args.push("--confine");
  if (input.egress) args.push("--egress", input.egress);
  return args;
}

function replyArgs(input: Parameters<DelamainAdapterShape["sendPeerReply"]>[0]): string[] {
  const args = ["resume", input.peerId, "--prompt", input.prompt];
  if (input.model) args.push("--model", input.model);
  if (input.yolo) args.push("--yolo");
  return args;
}

function sendArgs(input: Parameters<DelamainAdapterShape["sendMessage"]>[0]): string[] {
  const args = ["send", "--to", input.toPeerId, "--message", input.message];
  if (input.fromPeerId) args.push("--from", input.fromPeerId);
  if (input.expectReply) args.push("--expect-reply");
  if (input.responseId) args.push("--response-id", input.responseId);
  return args;
}

function normalizeParsedEvent(value: unknown): ParsedLogEvent {
  const event = rawRecord(value);
  const raw = typeof event.raw === "string" ? event.raw : undefined;
  return {
    type: typeof event.type === "string" && event.type.length > 0 ? event.type : "raw",
    text: typeof event.text === "string" ? event.text : null,
    label: typeof event.label === "string" ? event.label : null,
    isAgentMessage: Boolean(event.isAgentMessage),
    waitingQuestion: typeof event.waitingQuestion === "string" ? event.waitingQuestion : null,
    ...(raw === undefined ? {} : { raw }),
  };
}

function normalizeParsedLog(peerId: string, value: unknown): DelamainPeerLogParsedResult {
  const record = rawRecord(value);
  const events = Array.isArray(record.events) ? record.events.map(normalizeParsedEvent) : [];
  return {
    peerId: nullableString(record.peerId) ?? peerId,
    engine: nullableString(record.engine) ?? "unknown",
    events,
  };
}

// Fallback for old binaries without `--parsed`: wrap each raw line as a {type:"raw"} event.
function synthesizeRawParsedLog(peerId: string, text: string): DelamainPeerLogParsedResult {
  const events = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(
      (line): ParsedLogEvent => ({
        type: "raw",
        text: null,
        label: null,
        isAgentMessage: false,
        waitingQuestion: null,
        raw: line,
      }),
    );
  return { peerId, engine: "unknown", events };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => nullableString(v)).filter((v): v is string => v !== null)
    : [];
}

function normalizeWorkflowStatus(workflowId: string, value: unknown): DelamainWorkflowStatus {
  const record = rawRecord(value);
  // Real CLI JSON (`delamain workflow <id>`) nests the leaf peer ids at
  // workflow.agentPeerIds; the older peerIds/peers aliases stay as tolerant fallbacks.
  const workflow = rawRecord(record.workflow);
  return {
    id: nullableString(record.id ?? record.workflowId ?? workflow.id) ?? workflowId,
    status: rawStatus(record.status ?? workflow.status),
    label: nullableString(record.label ?? record.title ?? workflow.label ?? workflow.title),
    peerIds: stringArray(
      record.agentPeerIds ?? workflow.agentPeerIds ?? record.peerIds ?? record.peers,
    ),
  };
}

function runWorkflowArgs(input: Parameters<DelamainAdapterShape["runGoalWorkflow"]>[0]): string[] {
  return [
    "run-workflow",
    input.workflowScript,
    "--repo",
    input.repo,
    "--name",
    input.name,
    "--args-json",
    input.argsJson,
    "--detach",
  ];
}

// Operator launch (`gits.delamain.workflow.run`): name/argsJson are optional so a bare
// `run-workflow <script> --repo <repo> --detach` is valid. --detach stays last (mirrors
// runWorkflowArgs) so the CLI prints the detach JSON envelope.
function workflowRunArgs(input: Parameters<DelamainAdapterShape["runWorkflow"]>[0]): string[] {
  const args = ["run-workflow", input.script, "--repo", input.repo];
  if (input.name) args.push("--name", input.name);
  if (input.argsJson) args.push("--args-json", input.argsJson);
  args.push("--detach");
  return args;
}

function normalizeWorkflowKill(workflowId: string, value: unknown): DelamainWorkflowKillResult {
  const record = rawRecord(value);
  return {
    workflowId: nullableString(record.workflowId ?? record.id) ?? workflowId,
    status: rawStatus(record.status),
    peersKilled: stringArray(record.peersKilled),
  };
}

function normalizeMessage(value: unknown): DelamainMessage {
  const message = rawRecord(value);
  return {
    id: nullableString(message.id) ?? "unknown",
    fromPeerId: nullableString(message.fromPeerId) ?? "unknown",
    toPeerId: nullableString(message.toPeerId) ?? "unknown",
    message: typeof message.message === "string" ? message.message : "",
    expectReply: Boolean(message.expectReply),
    responseId: nullableString(message.responseId),
    createdAt: nullableString(message.createdAt),
    deliveredAt: nullableString(message.deliveredAt),
  };
}

function normalizeInbox(peerId: string, value: unknown): DelamainInboxResult {
  const record = rawRecord(value);
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return {
    peerId: nullableString(record.peerId) ?? peerId,
    messages: messages.map(normalizeMessage),
  };
}

function normalizeSendResult(value: unknown): DelamainSendMessageResult {
  const record = rawRecord(value);
  const delivery = rawRecord(record.delivery);
  const delivered = typeof delivery.delivered === "number" ? delivery.delivered : 0;
  return {
    responseId: nullableString(record.response_id ?? record.responseId),
    delivered: delivered >= 0 ? Math.trunc(delivered) : 0,
    skipped: nullableString(delivery.skipped),
  };
}

export const makeDelamainCliAdapter = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner;
  const providerInstances = yield* ProviderInstanceRegistry;

  const resolveLaunchEnvironment = (
    providerInstanceId: ProviderInstanceId | undefined,
    requestedEngine?: DelamainEngine | undefined,
    launchKind: "peer" | "workflow" = "peer",
  ) =>
    Effect.gen(function* () {
      if (providerInstanceId === undefined) return undefined;
      if (requestedEngine === undefined || requestedEngine === "unknown") {
        return yield* toDelamainError(
          `Routed Delamain launch for provider instance '${providerInstanceId}' requires a concrete engine.`,
        );
      }
      // `run-workflow` receives one process-wide environment but no leaf-engine route.
      // Until Delamain can pin each leaf explicitly, only the known Codex workflow is safe.
      if (launchKind === "workflow" && requestedEngine !== "codex") {
        return yield* toDelamainError(
          "Routed Delamain workflows currently support Codex only; per-leaf engine routing is unavailable.",
        );
      }
      const instance = yield* providerInstances.getInstance(providerInstanceId);
      if (!instance) {
        return yield* toDelamainError(
          `Provider instance '${providerInstanceId}' is unavailable for Delamain launch.`,
        );
      }
      if (!instance.enabled) {
        return yield* toDelamainError(
          `Provider instance '${providerInstanceId}' is disabled for Delamain launch.`,
        );
      }
      if (instance.driverKind !== requestedEngine) {
        return yield* toDelamainError(
          `Provider instance '${providerInstanceId}' driver '${instance.driverKind}' does not match requested engine '${requestedEngine}'.`,
        );
      }
      if (instance.workerEnvironment === undefined) {
        return yield* toDelamainError(
          `Provider instance '${providerInstanceId}' does not support Delamain worker launches.`,
        );
      }
      return { ...instance.workerEnvironment };
    });

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
    readPeerLogParsed: (input) => {
      const lines = input.lines ?? DEFAULT_LOG_LINES;
      const fallback = adapter
        .readPeerLog(input)
        .pipe(Effect.map((raw) => synthesizeRawParsedLog(input.peerId, raw.text)));
      return execDelamain(processRunner, ["log", input.peerId, String(lines), "--parsed"], {
        outputMode: "truncate",
      }).pipe(
        Effect.flatMap((result) => parseJson<unknown>("logParsed", result.stdout)),
        Effect.map((value) => normalizeParsedLog(input.peerId, value)),
        // Old binary (no --parsed) or malformed output -> raw fallback so the UI still works.
        Effect.catch(() => fallback),
      );
    },
    spawnPeer: (input) =>
      Effect.gen(function* () {
        const environment = yield* resolveLaunchEnvironment(input.providerInstanceId, input.engine);
        return yield* runJson<unknown>(processRunner, "spawn", spawnArgs(input), environment).pipe(
          Effect.map(normalizePeer),
        );
      }),
    runGoalWorkflow: (input) =>
      Effect.gen(function* () {
        const environment = yield* resolveLaunchEnvironment(
          input.providerInstanceId,
          input.engine,
          "workflow",
        );
        return yield* runJson<unknown>(
          processRunner,
          "run-workflow",
          runWorkflowArgs(input),
          environment,
        ).pipe(
          Effect.flatMap((value) => {
            const workflowId = nullableString(
              rawRecord(value).workflow_id ?? rawRecord(value).workflowId,
            );
            return workflowId === null
              ? Effect.fail(toDelamainError("Delamain run-workflow did not return a workflow_id."))
              : Effect.succeed({ workflowId } satisfies DelamainRunWorkflowResult);
          }),
        );
      }),
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
    readInbox: (input) =>
      runJson<unknown>(processRunner, "delamain.readInbox", [
        "inbox",
        input.peerId,
        ...(input.includeDelivered ? ["--all"] : []),
      ]).pipe(Effect.map((value) => normalizeInbox(input.peerId, value))),
    sendMessage: (input) =>
      runJson<unknown>(processRunner, "delamain.sendMessage", sendArgs(input)).pipe(
        Effect.map(normalizeSendResult),
      ),
    workflowStatus: (input) =>
      runJson<unknown>(processRunner, "workflow.status", ["workflow", input.workflowId]).pipe(
        Effect.map((value) => normalizeWorkflowStatus(input.workflowId, value)),
      ),
    workflowKill: (input) =>
      runJson<unknown>(processRunner, "workflow.kill", ["workflow", "kill", input.workflowId]).pipe(
        Effect.map((value) => normalizeWorkflowKill(input.workflowId, value)),
      ),
    runWorkflow: (input) =>
      Effect.gen(function* () {
        // Reject garbage before shelling — never pass an unparseable blob to the CLI.
        if (input.argsJson != null) {
          yield* Effect.try({
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            try: () => JSON.parse(input.argsJson as string) as unknown,
            catch: (cause) => toDelamainError("run-workflow argsJson is not valid JSON.", cause),
          });
        }
        const environment = yield* resolveLaunchEnvironment(
          input.providerInstanceId,
          input.engine,
          "workflow",
        );
        const value = yield* runJson<unknown>(
          processRunner,
          "run-workflow",
          workflowRunArgs(input),
          environment,
        );
        const record = rawRecord(value);
        const workflowId = nullableString(record.workflow_id ?? record.workflowId);
        if (workflowId === null) {
          return yield* toDelamainError("Delamain run-workflow did not return a workflow_id.");
        }
        return { workflowId, status: rawStatus(record.status) } satisfies DelamainWorkflowRunResult;
      }),
  };

  return adapter;
});

export const DelamainCliAdapterLive = Layer.effect(DelamainAdapter, makeDelamainCliAdapter).pipe(
  Layer.provide(ProcessRunnerLive),
);

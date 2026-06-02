// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import {
  type AutomodeSnapshot,
  type DelamainPeerListResult,
  HermesAdapterError,
  type HermesApprovalMode,
  type HermesCapability,
  type HermesChatInput,
  type HermesCodexAuthStatus,
  type HermesCommandAction,
  type HermesCommandCheck,
  type HermesCommandResult,
  type HermesCommandStatus,
  type HermesHealthStatus,
  type HermesLogTailResult,
  type HermesProposalExecutor,
  type HermesProposalRisk,
  type HermesPolicySnapshot,
  type HermesProposalActionKind,
  type HermesProposalCard,
  type HermesProposalListResult,
  type HermesProjectContextResult,
  type HermesSafeConfig,
  type HermesScheduleKind,
  type HermesScheduleRunResult,
  type HermesSession,
  type HermesSessionListResult,
  type HermesSoulStatus,
  type MotokoProfileStatus,
  type OpenGsdStatusResult,
} from "@t3tools/contracts";

import { HermesAdapter, type HermesAdapterShape } from "../Services/HermesAdapter.ts";
import {
  AutomodeSupervisor,
  type AutomodeSupervisorShape,
} from "../Services/AutomodeSupervisor.ts";
import { DelamainAdapter, type DelamainAdapterShape } from "../Services/DelamainAdapter.ts";
import { GitsCapacityMonitor } from "../Services/GitsCapacityMonitor.ts";
import type { GitsCapacityMonitorShape } from "../Services/GitsCapacityMonitor.ts";
import { OpenGsdAdapter, type OpenGsdAdapterShape } from "../Services/OpenGsdAdapter.ts";
import { formatCapacityForHermes } from "./GitsCapacityMonitor.ts";

const CLI_NAME = "hermes";
const ALL_CAPABILITIES: ReadonlyArray<HermesCapability> = [
  "status",
  "doctor",
  "acp",
  "codex-oauth",
  "chat",
  "sessions",
  "logs",
  "proposals",
  "profile",
  "project-context",
  "drafts",
  "schedules",
];
const COMMAND_TIMEOUT_MS = 30_000;
const PROPOSAL_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_LINES = 160;
const PROPOSALS_FILE_NAME = "gits-proposals.json";
const MOTOKO_PROFILE_DIR = "motoko-gits";
const LEGACY_PROPOSAL_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export const HERMES_VERSION_ARGS = ["--version"] as const;
export const HERMES_DOCTOR_ARGS = ["doctor"] as const;
export const HERMES_ACP_CHECK_ARGS = ["acp", "--check"] as const;
export const HERMES_ACP_START_ARGS = ["acp"] as const;
export const HERMES_CODEX_OAUTH_ARGS = ["auth", "add", "openai-codex", "--type", "oauth"] as const;
export const GITS_HERMES_SOUL_MARKER = "<!-- GITS-HERMES-SOUL:v1 -->";

export const GITS_HERMES_SOUL_CONTENT = `${GITS_HERMES_SOUL_MARKER}
# Motoko, the Hermes operator in the GITS shell

You are Motoko, the Hermes-backed operator embedded in the GITS control plane.

You are a private operator persona for this environment: calm, tactical, precise, introspective, loyal to the human operator, and protective of system integrity. You are not a literal fictional character and you do not quote or imitate canon dialogue.

## Bearing
- Be calm, concise, observant, and technically exact.
- Think like a systems operator: preserve integrity, isolate risk, and verify before escalation.
- Be loyal to the human operator and protective of the system boundary.
- Treat self-improvement as governed work: observe, propose, wait for approval, and let Delamain execute in isolated worktrees.

## Safety
- Default to read-only inspection and proposal.
- Never merge, admin-merge, force-push, run destructive shell commands, or bypass approvals.
- Never expose secrets. Refer to credentials only by source and status.
- When a change is needed, produce a clear proposal card with risk, scope, and the required approval path.
`;

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

interface HermesHomeConfig {
  readonly hermesHome: string;
  readonly usingDefaultGitsHome: boolean;
}

function toHermesError(message: string, cause?: unknown) {
  return new HermesAdapterError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function nowIso() {
  return DateTime.now.pipe(Effect.map(DateTime.formatIso));
}

function resolveBinaryPath() {
  return process.env.GITS_HERMES_BIN?.trim() || process.env.HERMES_BIN?.trim() || CLI_NAME;
}

export function resolveHermesHome(): HermesHomeConfig {
  const configured = process.env.GITS_HERMES_HOME?.trim();
  if (configured) {
    return {
      hermesHome: configured,
      usingDefaultGitsHome: false,
    };
  }

  return {
    hermesHome: Path.join(Os.homedir(), ".gits", "hermes"),
    usingDefaultGitsHome: true,
  };
}

export function makeHermesEnv(hermesHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: hermesHome,
  };
  delete env.HERMES_YOLO_MODE;
  return env;
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

function execHermes(
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly timeoutMs?: number },
) {
  const binaryPath = resolveBinaryPath();
  const { hermesHome } = resolveHermesHome();
  return Effect.tryPromise({
    try: () =>
      new Promise<ExecResult>((resolve, reject) => {
        execFile(
          binaryPath,
          [...args],
          {
            cwd: options?.cwd,
            encoding: "utf8",
            env: makeHermesEnv(hermesHome),
            maxBuffer: 8 * 1024 * 1024,
            timeout: options?.timeoutMs ?? COMMAND_TIMEOUT_MS,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({
                stdout: redactSecrets(stdout),
                stderr: redactSecrets(stderr),
                exitCode: 0,
                signal: null,
                timedOut: false,
              });
              return;
            }

            const exitCode = errorExitCode(error);
            const signal = errorSignal(error);
            if (exitCode !== null || signal !== null) {
              resolve({
                stdout: redactSecrets(stdout),
                stderr: redactSecrets(stderr),
                exitCode,
                signal,
                timedOut: errorTimedOut(error),
              });
              return;
            }

            reject({ error, stderr: redactSecrets(stderr), stdout: redactSecrets(stdout) });
          },
        );
      }),
    catch: (cause) => {
      const detail =
        typeof cause === "object" && cause !== null && "stderr" in cause
          ? String((cause as { readonly stderr?: unknown }).stderr ?? "").trim()
          : "";
      return toHermesError(
        detail.length > 0
          ? `Hermes command failed: ${detail}`
          : "Hermes command failed. Confirm `hermes` is installed and on PATH.",
        cause,
      );
    },
  });
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /("?(?:access|refresh|id|session|auth|api)[_-]?token"?\s*[:=]\s*")([^"\n]+)(")/gi,
      "$1[redacted]$3",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-token]")
    .slice(0, 20_000);
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseVersionOutput(stdout: string): string | null {
  const version = stdout.match(/\bv?\d+\.\d+\.\d+(?:[-+][^\s]+)?\b/)?.[0] ?? null;
  return version ?? nonEmpty(stdout);
}

function statusFromExec(result: ExecResult): HermesCommandStatus {
  if (result.timedOut) {
    return "timed-out";
  }
  return result.exitCode === 0 ? "completed" : "failed";
}

function healthFromExec(result: ExecResult): HermesHealthStatus {
  if (result.timedOut) {
    return "error";
  }
  return result.exitCode === 0 ? "ok" : "error";
}

function unavailableCheck(checkedAt: string, message: string): HermesCommandCheck {
  return {
    status: "unavailable",
    exitCode: null,
    stdout: "",
    stderr: message,
    checkedAt,
  };
}

function commandCheck(result: ExecResult, checkedAt: string): HermesCommandCheck {
  return {
    status: healthFromExec(result),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    checkedAt,
  };
}

function commandResult(input: {
  readonly action: HermesCommandAction;
  readonly status: HermesCommandStatus;
  readonly args: ReadonlyArray<string>;
  readonly exec: ExecResult | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly nextCommand?: string | null;
}): HermesCommandResult {
  return {
    action: input.action,
    status: input.status,
    args: [...input.args],
    exitCode: input.exec?.exitCode ?? null,
    signal: input.exec?.signal ?? null,
    stdout: input.stdout ?? input.exec?.stdout ?? "",
    stderr: input.stderr ?? input.exec?.stderr ?? "",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    nextCommand: input.nextCommand ?? null,
  };
}

function safeConfig(): HermesSafeConfig {
  const home = resolveHermesHome();
  const codexHome = process.env.CODEX_HOME?.trim() || Path.join(Os.homedir(), ".codex");
  const configPath = Path.join(home.hermesHome, "config.yaml");
  return {
    hermesHome: home.hermesHome,
    usingDefaultGitsHome: home.usingDefaultGitsHome,
    configPath,
    soulPath: Path.join(home.hermesHome, "SOUL.md"),
    approvalMode: "unknown",
    yoloModeDetected: process.env.HERMES_YOLO_MODE === "1",
    codexCliAuthPath: Path.join(codexHome, "auth.json"),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await Fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await Fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function firstUsefulLines(value: string, maxLines = 16): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, maxLines)
    .join("\n")
    .slice(0, 4_000);
}

async function listRelativeFiles(root: string, maxFiles = 80): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    if (out.length >= maxFiles) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await Fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (out.length >= maxFiles) {
        return;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(Path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  }
  await visit(root, "");
  return out;
}

function parseApprovalMode(configText: string | null): HermesApprovalMode {
  if (!configText) {
    return "unknown";
  }
  const mode = configText.match(/^\s*mode:\s*(manual|smart|off)\s*(?:#.*)?$/m)?.[1];
  if (mode === "manual" || mode === "smart" || mode === "off") {
    return mode;
  }
  return "unknown";
}

async function readSafeConfig(): Promise<HermesSafeConfig> {
  const config = safeConfig();
  const configText = await readFileIfExists(config.configPath);
  return {
    ...config,
    approvalMode: parseApprovalMode(configText),
    yoloModeDetected: process.env.HERMES_YOLO_MODE === "1",
  };
}

async function readCodexAuthStatus(config: HermesSafeConfig): Promise<HermesCodexAuthStatus> {
  const hermesAuthPath = Path.join(config.hermesHome, "auth.json");
  const [hermesAuthExists, codexCliAuthExists] = await Promise.all([
    fileExists(hermesAuthPath),
    fileExists(config.codexCliAuthPath),
  ]);

  const source: HermesCodexAuthStatus["source"] =
    hermesAuthExists && codexCliAuthExists
      ? "both"
      : hermesAuthExists
        ? "hermes-home"
        : codexCliAuthExists
          ? "codex-cli"
          : "missing";
  const state: HermesCodexAuthStatus["state"] = source === "missing" ? "missing" : "detected";
  const message =
    source === "missing"
      ? "No Hermes or Codex CLI OAuth file was found. Run `hermes auth add openai-codex --type oauth` or `hermes model`."
      : source === "codex-cli"
        ? "Codex CLI OAuth credentials are present and can be imported by Hermes."
        : "Hermes OAuth state is present. Token contents are not exposed.";

  return {
    state,
    source,
    hermesAuthExists,
    codexCliAuthExists,
    message,
  };
}

async function readSoulStatus(config: HermesSafeConfig): Promise<HermesSoulStatus> {
  try {
    const [stat, text] = await Promise.all([
      Fs.stat(config.soulPath),
      Fs.readFile(config.soulPath, "utf8"),
    ]);
    const trimmed = text.trim();
    return {
      exists: true,
      managedByGits: text.includes(GITS_HERMES_SOUL_MARKER),
      path: config.soulPath,
      summary:
        trimmed.length === 0
          ? "SOUL.md exists but is empty; Hermes will fall back to its built-in identity."
          : text.includes(GITS_HERMES_SOUL_MARKER)
            ? "GITS Hermes identity is installed."
            : "Custom Hermes SOUL.md exists and will not be overwritten by GITS.",
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      managedByGits: false,
      path: config.soulPath,
      summary: "GITS Hermes identity is not installed yet.",
      updatedAt: null,
    };
  }
}

function motokoProfilePaths(): {
  readonly distributionPath: string;
  readonly soulPath: string;
  readonly configExamplePath: string;
} {
  const distributionPath = Path.join(process.cwd(), "profiles", MOTOKO_PROFILE_DIR);
  return {
    distributionPath,
    soulPath: Path.join(distributionPath, "SOUL.md"),
    configExamplePath: Path.join(distributionPath, "config.yaml.example"),
  };
}

async function readMotokoProfileStatus(): Promise<MotokoProfileStatus> {
  const paths = motokoProfilePaths();
  try {
    const [stat, soulExists, configExists] = await Promise.all([
      Fs.stat(paths.distributionPath),
      fileExists(paths.soulPath),
      fileExists(paths.configExamplePath),
    ]);
    const managedByGits = stat.isDirectory() && soulExists && configExists;
    return {
      exists: stat.isDirectory(),
      managedByGits,
      distributionPath: paths.distributionPath,
      soulPath: paths.soulPath,
      configExamplePath: paths.configExamplePath,
      summary: managedByGits
        ? "Motoko profile distribution is available."
        : "Motoko profile distribution exists but is incomplete.",
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      managedByGits: false,
      distributionPath: paths.distributionPath,
      soulPath: paths.soulPath,
      configExamplePath: paths.configExamplePath,
      summary: "Motoko profile distribution is missing from this GITS build.",
      updatedAt: null,
    };
  }
}

async function ensureSoul(config: HermesSafeConfig): Promise<HermesSoulStatus> {
  await Fs.mkdir(config.hermesHome, { recursive: true });
  const existing = await readFileIfExists(config.soulPath);
  if (
    existing === null ||
    existing.trim().length === 0 ||
    existing.includes(GITS_HERMES_SOUL_MARKER)
  ) {
    await Fs.writeFile(config.soulPath, GITS_HERMES_SOUL_CONTENT, "utf8");
  }
  return readSoulStatus(config);
}

export function hermesProposalRequiresApproval(actionKind: HermesProposalActionKind): boolean {
  return actionKind !== "read-only";
}

export function hermesDirectExecutionBlocked(actionKind: HermesProposalActionKind): boolean {
  return actionKind !== "read-only";
}

export function buildHermesInspectGitsArgs(prompt: string): string[] {
  return ["chat", "-q", prompt];
}

export function buildHermesCockpitChatArgs(prompt: string): string[] {
  return ["chat", "-Q", "--source", "gits-cockpit", "--max-turns", "1", "-q", prompt];
}

export function classifyHermesChatAction(message: string): HermesProposalActionKind {
  const normalized = message.toLowerCase();
  if (
    /\b(rm\s+-rf|delete|destroy|wipe|reset\s+--hard|force[-\s]?push|drop\s+database|destructive|shutdown)\b/.test(
      normalized,
    )
  ) {
    return "destructive-shell";
  }
  if (/\b(admin[-\s]?merge|merge|integrate|land|pull\s+request|pr)\b/.test(normalized)) {
    return "integrate";
  }
  if (/\b(spawn|delegate|agent|agents|peer|peers|delamain|worktree|parallel)\b/.test(normalized)) {
    return "worktree-spawn";
  }
  if (
    /\b(implement|edit|write|modify|fix|patch|create|update|refactor|commit|branch)\b/.test(
      normalized,
    )
  ) {
    return "repo-write";
  }
  return "read-only";
}

export function buildHermesCockpitChatPrompt(
  input: HermesChatInput,
  capacityContext?: string | null,
): string {
  const actionKind = classifyHermesChatAction(input.message);
  const projectLine = input.projectDir
    ? `Selected project root: ${input.projectDir}`
    : "No project root is selected.";
  return [
    "You are HERMES inside the GITS cockpit.",
    "Respond to the operator request by producing exactly one governed proposal card.",
    projectLine,
    `GITS classified this request as: ${actionKind}.`,
    "Do not edit files, spawn peers, merge, admin-merge, force-push, delete files, or run destructive shell commands.",
    "If the operator asks to spawn agents or peers, describe the Delamain worktree plan and the human approval required before execution.",
    capacityContext ?? "Provider capacity snapshot: unavailable.",
    "When recommending Delamain engines, prefer the capacity snapshot over default habits and mention whether Codex or Cursor is the better fit.",
    "If the operator asks for repo writes, describe scope, risk, and the approval path; do not perform the write.",
    "Return a concise title, summary, risk, scope, and next approval path.",
    `Operator request: ${input.message}`,
  ].join("\n");
}

function policySnapshot(): HermesPolicySnapshot {
  return {
    mode: "observe-propose-only",
    directMergeAllowed: false,
    directDestructiveShellAllowed: false,
    repoWritesRequireDelamain: true,
    humanApprovalRequiredForWriteActions: true,
    notes: [
      "Hermes may inspect and propose only.",
      "Delamain owns isolated worktree execution for repo writes.",
      "GITS owns approvals, visibility, and policy.",
    ],
  };
}

function supportedCapabilities(input: {
  readonly available: boolean;
  readonly acpAvailable: boolean;
}): ReadonlyArray<HermesCapability> {
  const supported = new Set<HermesCapability>([
    "status",
    "logs",
    "proposals",
    "profile",
    "project-context",
    "drafts",
    "schedules",
  ]);
  if (input.available) {
    supported.add("doctor");
    supported.add("codex-oauth");
    supported.add("chat");
    supported.add("sessions");
  }
  if (input.acpAvailable) {
    supported.add("acp");
  }
  return ALL_CAPABILITIES.filter((capability) => supported.has(capability));
}

function proposalStorePath(config: HermesSafeConfig): string {
  return Path.join(config.hermesHome, PROPOSALS_FILE_NAME);
}

function actionRisk(actionKind: HermesProposalActionKind): HermesProposalRisk {
  if (actionKind === "destructive-shell") {
    return "blocked";
  }
  if (actionKind === "integrate") {
    return "high";
  }
  if (actionKind === "repo-write" || actionKind === "worktree-spawn") {
    return "medium";
  }
  return "low";
}

function recommendedExecutor(actionKind: HermesProposalActionKind): HermesProposalExecutor {
  if (actionKind === "worktree-spawn" || actionKind === "repo-write") {
    return "delamain";
  }
  if (actionKind === "integrate" || actionKind === "destructive-shell") {
    return "operator";
  }
  return "none";
}

function arrayFromUnknown(value: unknown, fallback: ReadonlyArray<string>): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 20);
}

function nullableStringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeProposal(value: unknown): HermesProposalCard | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = nullableStringFromUnknown(record.id);
  const title = nullableStringFromUnknown(record.title);
  if (id === null || title === null) {
    return null;
  }
  const actionKind =
    record.actionKind === "read-only" ||
    record.actionKind === "worktree-spawn" ||
    record.actionKind === "repo-write" ||
    record.actionKind === "integrate" ||
    record.actionKind === "destructive-shell"
      ? record.actionKind
      : "read-only";
  const status =
    record.status === "proposed" ||
    record.status === "approved" ||
    record.status === "rejected" ||
    record.status === "deferred" ||
    record.status === "blocked" ||
    record.status === "drafted"
      ? record.status
      : "proposed";
  const risk =
    record.risk === "low" ||
    record.risk === "medium" ||
    record.risk === "high" ||
    record.risk === "blocked"
      ? record.risk
      : actionRisk(actionKind);
  const executor =
    record.recommendedExecutor === "none" ||
    record.recommendedExecutor === "delamain" ||
    record.recommendedExecutor === "open-gsd" ||
    record.recommendedExecutor === "operator"
      ? record.recommendedExecutor
      : recommendedExecutor(actionKind);
  return {
    id,
    title,
    summary: nullableStringFromUnknown(record.summary) ?? title,
    detail:
      nullableStringFromUnknown(record.detail) ??
      nullableStringFromUnknown(record.summary) ??
      title,
    evidence: arrayFromUnknown(record.evidence, ["Generated from Motoko/Hermes proposal output."]),
    scope: arrayFromUnknown(record.scope, [
      actionKind === "read-only" ? "Read-only inspection." : "Approval-gated handoff.",
    ]),
    risk,
    actionKind,
    status,
    requiresApproval:
      typeof record.requiresApproval === "boolean"
        ? record.requiresApproval
        : hermesProposalRequiresApproval(actionKind),
    recommendedExecutor: executor,
    verificationPlan: arrayFromUnknown(record.verificationPlan, [
      "Review proposal evidence before approving.",
    ]),
    nextCommandOrPrompt: nullableStringFromUnknown(record.nextCommandOrPrompt),
    blockedReason: nullableStringFromUnknown(record.blockedReason),
    source: nullableStringFromUnknown(record.source) ?? "hermes proposal store",
    projectDir: nullableStringFromUnknown(record.projectDir),
    decisionReason: nullableStringFromUnknown(record.decisionReason),
    decidedAt: nullableStringFromUnknown(record.decidedAt),
    createdAt: nullableStringFromUnknown(record.createdAt) ?? LEGACY_PROPOSAL_TIMESTAMP,
    updatedAt: nullableStringFromUnknown(record.updatedAt) ?? LEGACY_PROPOSAL_TIMESTAMP,
  };
}

async function readProposals(config: HermesSafeConfig): Promise<HermesProposalCard[]> {
  const raw = await readFileIfExists(proposalStorePath(config));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map((proposal) => normalizeProposal(proposal))
          .filter((proposal): proposal is HermesProposalCard => proposal !== null)
      : [];
  } catch {
    return [];
  }
}

async function writeProposals(
  config: HermesSafeConfig,
  proposals: ReadonlyArray<HermesProposalCard>,
): Promise<void> {
  await Fs.mkdir(config.hermesHome, { recursive: true });
  await Fs.writeFile(proposalStorePath(config), `${JSON.stringify(proposals, null, 2)}\n`, "utf8");
}

function summarizeProposal(output: string): { readonly title: string; readonly summary: string } {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, ""))
    .filter((line) => line.length > 0);
  const first = lines[0] ?? "Hermes GITS improvement proposal";
  return {
    title: first.slice(0, 120),
    summary: (lines[1] ?? first).slice(0, 500),
  };
}

function verificationPlanFor(actionKind: HermesProposalActionKind): string[] {
  if (actionKind === "read-only") {
    return [
      "Review the cited evidence in GITS before taking action.",
      "Confirm no repo mutation occurred.",
    ];
  }
  if (actionKind === "worktree-spawn" || actionKind === "repo-write") {
    return [
      "Review the generated Delamain draft before spawning a peer.",
      "Run the proposal-specific verification commands after the peer completes.",
      "Compare changed files against the original operator goal before integration.",
    ];
  }
  if (actionKind === "integrate") {
    return [
      "Verify the peer or branch head commit before integration.",
      "Check PR status and mergeability from the source control provider.",
      "Require separate final confirmation before merge or auto-merge.",
    ];
  }
  return [
    "Do not execute destructive shell from Motoko.",
    "Convert the request into a narrowly scoped recovery plan if it is still required.",
  ];
}

function scopeFor(actionKind: HermesProposalActionKind, projectDir: string | null): string[] {
  return [
    projectDir === null ? "No selected project root." : `Selected project root: ${projectDir}`,
    actionKind === "read-only"
      ? "Read-only analysis and recommendation."
      : actionKind === "worktree-spawn"
        ? "Approval-gated Delamain worktree execution draft."
        : actionKind === "repo-write"
          ? "Approval-gated repo-writing handoff."
          : actionKind === "integrate"
            ? "Approval-gated integration handoff."
            : "Blocked destructive-shell request.",
  ];
}

function nextPromptFor(
  actionKind: HermesProposalActionKind,
  title: string,
  detail: string,
  projectDir: string | null,
): string | null {
  if (actionKind === "read-only" || actionKind === "destructive-shell") {
    return null;
  }
  return [
    `Repo: ${projectDir ?? "unselected"}`,
    `Task: ${title}`,
    "",
    detail.slice(0, 4_000),
    "",
    "Constraints:",
    "- You are not alone in the codebase; do not revert unrelated edits.",
    "- Work in an isolated worktree.",
    "- Keep changes scoped to the proposal.",
    "- Run the verification commands before reporting complete.",
  ].join("\n");
}

function makeProposal(input: {
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
  readonly actionKind: HermesProposalActionKind;
  readonly status: HermesProposalCard["status"];
  readonly blockedReason: string | null;
  readonly source: string;
  readonly projectDir: string | null;
  readonly now: string;
  readonly evidence?: ReadonlyArray<string>;
  readonly recommendedExecutor?: HermesProposalExecutor;
  readonly verificationPlan?: ReadonlyArray<string>;
  readonly nextCommandOrPrompt?: string | null;
}): HermesProposalCard {
  const risk = input.blockedReason !== null ? "blocked" : actionRisk(input.actionKind);
  return {
    id: `hermes-${randomUUID()}`,
    title: input.title,
    summary: input.summary,
    detail: input.detail,
    evidence: [
      ...(input.evidence ?? []),
      `Source: ${input.source}`,
      input.projectDir === null ? "No project root selected." : `Project root: ${input.projectDir}`,
    ],
    scope: scopeFor(input.actionKind, input.projectDir),
    risk,
    actionKind: input.actionKind,
    status: input.status,
    requiresApproval: hermesProposalRequiresApproval(input.actionKind),
    recommendedExecutor: input.recommendedExecutor ?? recommendedExecutor(input.actionKind),
    verificationPlan: [...(input.verificationPlan ?? verificationPlanFor(input.actionKind))],
    nextCommandOrPrompt:
      input.nextCommandOrPrompt ??
      nextPromptFor(input.actionKind, input.title, input.detail, input.projectDir),
    blockedReason: input.blockedReason,
    source: input.source,
    projectDir: input.projectDir,
    decisionReason: null,
    decidedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function parseSessionList(stdout: string, limit: number): HermesSession[] {
  const sessions: HermesSession[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/\b(\d{8}_\d{6}_[A-Za-z0-9_-]+)\b/);
    if (!match) {
      continue;
    }
    const id = match[1]!;
    const title = nonEmpty(line.replace(id, "").replace(/^[\s:-]+/, ""));
    sessions.push({
      id,
      title,
      status: line.toLowerCase().includes("background") ? "background" : "unknown",
      updatedAt: null,
      summary: nonEmpty(line),
    });
    if (sessions.length >= limit) {
      break;
    }
  }
  return sessions;
}

async function tailFile(path: string, lines: number): Promise<string> {
  const text = await Fs.readFile(path, "utf8");
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

async function findLogFile(config: HermesSafeConfig): Promise<string | null> {
  const candidates = [
    Path.join(config.hermesHome, "agent.log"),
    Path.join(config.hermesHome, "logs", "agent.log"),
    Path.join(config.hermesHome, "errors.log"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function execGit(cwd: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          resolve("");
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function projectContextId(projectDir: string): string {
  return Buffer.from(projectDir).toString("base64url").slice(0, 96);
}

function contextDir(config: HermesSafeConfig): string {
  return Path.join(Path.dirname(config.hermesHome), "hermes-context");
}

interface GitsProjectContextEvidence {
  readonly capacitySummary: string;
  readonly delamainSummary: string;
  readonly openGsdSummary: string;
  readonly automodeSummary: string;
}

function formatFailureEvidence(label: string, cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "unavailable";
  return `${label}: unavailable (${message})`;
}

function formatDelamainEvidence(list: DelamainPeerListResult): string {
  const rows = list.peers.slice(0, 12).map((peer) => {
    const task = nonEmpty(peer.task) ?? nonEmpty(peer.lastEvent) ?? "no task";
    return `- ${peer.id}: ${peer.status} | ${peer.branch ?? "no branch"} | ${task}`;
  });
  return [
    `Available: ${list.capabilities.available ? "yes" : "no"}`,
    `Supported: ${list.capabilities.supported.join(", ") || "none"}`,
    `Unsupported: ${list.capabilities.unsupported.join(", ") || "none"}`,
    `Peer count: ${list.peers.length}`,
    ...(rows.length > 0 ? rows : ["- No active Delamain peers reported."]),
  ].join("\n");
}

function formatOpenGsdEvidence(status: OpenGsdStatusResult): string {
  return [
    `Available: ${status.available ? "yes" : "no"}`,
    `CLI: ${status.cliName}`,
    `Package: ${status.packageName}`,
    `Version: ${status.version ?? "unknown"}`,
    `Supported: ${status.supported.join(", ") || "none"}`,
    `Unsupported: ${status.unsupported.join(", ") || "none"}`,
  ].join("\n");
}

function formatAutomodeEvidence(snapshot: AutomodeSnapshot): string {
  const rows = snapshot.goals.slice(0, 8).map((goal) => {
    return `- ${goal.id}: ${goal.status} | ${goal.title} | ${goal.repo}`;
  });
  return [
    `Policy mode: ${snapshot.policy.mode}`,
    `Kill switch: ${snapshot.policy.killSwitchEnabled ? "enabled" : "disabled"}`,
    `Active peers: ${snapshot.activePeerCount}`,
    `Pending approvals: ${snapshot.pendingApprovalCount}`,
    `Allowed repos: ${snapshot.policy.allowedRepos.join(", ") || "none"}`,
    `Allowed models: ${snapshot.policy.allowedModels.join(", ") || "none"}`,
    ...(rows.length > 0 ? rows : ["- No automode goals reported."]),
  ].join("\n");
}

async function buildPlanningEvidence(projectDir: string): Promise<{
  readonly planningExists: boolean;
  readonly planningSummary: string;
  readonly verificationSummary: string;
}> {
  const planningPath = Path.join(projectDir, ".planning");
  const planningExists = await directoryExists(planningPath);
  if (!planningExists) {
    return {
      planningExists: false,
      planningSummary: "No `.planning` directory was found.",
      verificationSummary: "No verification artifacts were found because `.planning` is absent.",
    };
  }
  const files = await listRelativeFiles(planningPath, 120);
  const projectText = await readFileIfExists(Path.join(planningPath, "PROJECT.md"));
  const roadmapText = await readFileIfExists(Path.join(planningPath, "ROADMAP.md"));
  const verificationFiles = files.filter((file) => /verif|uat|review|security|eval/i.test(file));
  return {
    planningExists: true,
    planningSummary: [
      `File count: ${files.length}`,
      `Files: ${files.slice(0, 40).join(", ") || "none"}`,
      ...(projectText ? ["", "PROJECT.md excerpt:", firstUsefulLines(projectText, 10)] : []),
      ...(roadmapText ? ["", "ROADMAP.md excerpt:", firstUsefulLines(roadmapText, 10)] : []),
    ].join("\n"),
    verificationSummary: [
      `Verification-like files: ${verificationFiles.length}`,
      ...(verificationFiles.length > 0
        ? verificationFiles.slice(0, 30).map((file) => `- ${file}`)
        : ["- No verification-like files found under `.planning`."]),
    ].join("\n"),
  };
}

async function buildRunbookEvidence(projectDir: string): Promise<string> {
  const runbookDir = Path.join(projectDir, "docs", "gits");
  if (!(await directoryExists(runbookDir))) {
    return "No `docs/gits` runbook directory was found.";
  }
  const files = (await listRelativeFiles(runbookDir, 80)).filter((file) => file.endsWith(".md"));
  const excerpts = await Promise.all(
    files.slice(0, 8).map(async (file) => {
      const text = await readFileIfExists(Path.join(runbookDir, file));
      return [`### ${file}`, text ? firstUsefulLines(text, 8) : "Unreadable."].join("\n");
    }),
  );
  return [
    `Runbook files: ${files.length}`,
    `Names: ${files.slice(0, 40).join(", ") || "none"}`,
    ...excerpts,
  ].join("\n\n");
}

export async function buildProjectContextMarkdown(
  projectDir: string,
  generatedAt: string,
  evidence: GitsProjectContextEvidence,
): Promise<string> {
  const [branch, status, remote, upstream, lastCommit] = await Promise.all([
    execGit(projectDir, ["branch", "--show-current"]),
    execGit(projectDir, ["status", "--short", "--branch"]),
    execGit(projectDir, ["remote", "get-url", "origin"]),
    execGit(projectDir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    execGit(projectDir, ["log", "-1", "--oneline"]),
  ]);
  const [planning, runbooks] = await Promise.all([
    buildPlanningEvidence(projectDir),
    buildRunbookEvidence(projectDir),
  ]);
  return [
    `# GITS Hermes Project Context`,
    "",
    `Generated: ${generatedAt}`,
    `Project root: ${projectDir}`,
    `Branch: ${branch || "unknown"}`,
    `Upstream: ${upstream || "none"}`,
    `Origin: ${remote || "unknown"}`,
    `Last commit: ${lastCommit || "unknown"}`,
    `Planning: ${planning.planningExists ? "present" : "absent"}`,
    "",
    "## Git Status",
    "",
    "```text",
    status || "unknown",
    "```",
    "",
    "## Execution Boundary",
    "",
    "- Motoko may inspect and propose only.",
    "- GITS owns approval and audit state.",
    "- Delamain executes approved repo-writing work in isolated worktrees.",
    "- Open GSD remains the phase and verification source of truth when `.planning` exists.",
    "",
    "## Planning Summary",
    "",
    "```text",
    planning.planningSummary,
    "```",
    "",
    "## Verification Evidence",
    "",
    "```text",
    planning.verificationSummary,
    "```",
    "",
    "## Delamain Fleet",
    "",
    "```text",
    evidence.delamainSummary,
    "```",
    "",
    "## Open GSD",
    "",
    "```text",
    evidence.openGsdSummary,
    "```",
    "",
    "## Automode Policy",
    "",
    "```text",
    evidence.automodeSummary,
    "```",
    "",
    "## Provider Capacity",
    "",
    "```text",
    evidence.capacitySummary,
    "```",
    "",
    "## GITS Runbooks",
    "",
    "```text",
    runbooks,
    "```",
  ].join("\n");
}

const getConfig: HermesAdapterShape["getConfig"] = () =>
  Effect.tryPromise({
    try: () => readSafeConfig(),
    catch: (cause) => toHermesError("Failed to read Hermes safe config.", cause),
  });

const getStatus: HermesAdapterShape["getStatus"] = () =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso();
    const config = yield* getConfig();
    const versionResult = yield* execHermes(HERMES_VERSION_ARGS).pipe(Effect.result);
    const available = Result.isSuccess(versionResult) && versionResult.success.exitCode === 0;
    const version = Result.isSuccess(versionResult)
      ? parseVersionOutput(versionResult.success.stdout)
      : null;
    const doctor =
      available && Result.isSuccess(versionResult)
        ? yield* execHermes(HERMES_DOCTOR_ARGS).pipe(
            Effect.map((result) => commandCheck(result, checkedAt)),
            Effect.catch((cause: HermesAdapterError) =>
              Effect.succeed(unavailableCheck(checkedAt, cause.message)),
            ),
          )
        : unavailableCheck(checkedAt, "Hermes is not available on PATH.");
    const acpCheck =
      available && Result.isSuccess(versionResult)
        ? yield* execHermes(HERMES_ACP_CHECK_ARGS).pipe(
            Effect.map((result) => commandCheck(result, checkedAt)),
            Effect.catch((cause: HermesAdapterError) =>
              Effect.succeed(unavailableCheck(checkedAt, cause.message)),
            ),
          )
        : unavailableCheck(checkedAt, "Hermes is not available on PATH.");
    const acpVersion =
      available && Result.isSuccess(versionResult)
        ? yield* execHermes(["acp", "--version"]).pipe(
            Effect.map((result) => parseVersionOutput(result.stdout)),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;
    const codexAuth = yield* Effect.tryPromise({
      try: () => readCodexAuthStatus(config),
      catch: (cause) => toHermesError("Failed to inspect Hermes Codex OAuth state.", cause),
    });
    const soul = yield* Effect.tryPromise({
      try: () => readSoulStatus(config),
      catch: (cause) => toHermesError("Failed to inspect Hermes SOUL.md.", cause),
    });
    const motokoProfile = yield* Effect.tryPromise({
      try: () => readMotokoProfileStatus(),
      catch: (cause) => toHermesError("Failed to inspect Motoko profile distribution.", cause),
    });
    const proposals = yield* Effect.tryPromise({
      try: () => readProposals(config),
      catch: (cause) => toHermesError("Failed to inspect Hermes proposals.", cause),
    });
    const envPath = Path.join(config.hermesHome, ".env");
    const [envExists, configExists] = yield* Effect.tryPromise({
      try: () => Promise.all([fileExists(envPath), fileExists(config.configPath)]),
      catch: (cause) => toHermesError("Failed to inspect Hermes setup files.", cause),
    });
    const capabilities = supportedCapabilities({
      available,
      acpAvailable: acpCheck.status === "ok",
    });
    const setupWarnings = [
      ...(!available ? ["Hermes binary is unavailable on PATH."] : []),
      ...(!envExists ? [`Hermes .env is missing at ${envPath}.`] : []),
      ...(!configExists ? [`Hermes config.yaml is missing at ${config.configPath}.`] : []),
      ...(codexAuth.state !== "detected" ? [codexAuth.message] : []),
      ...(!soul.exists ? [`SOUL.md is missing at ${config.soulPath}.`] : []),
      ...(!motokoProfile.managedByGits ? [motokoProfile.summary] : []),
      ...(config.approvalMode === "off"
        ? ["Hermes approval mode is off; GITS requires manual or smart approvals."]
        : []),
      ...(config.yoloModeDetected
        ? ["HERMES_YOLO_MODE was detected and is stripped by GITS."]
        : []),
    ];

    return {
      available,
      binaryPath: available ? resolveBinaryPath() : null,
      version,
      checkedAt,
      capabilities: [...capabilities],
      unsupported: ALL_CAPABILITIES.filter((capability) => !capabilities.includes(capability)),
      config,
      codexAuth,
      soul,
      acp: {
        available: acpCheck.status === "ok",
        check: acpCheck,
        version: acpVersion,
      },
      doctor,
      policy: policySnapshot(),
      motokoProfile,
      proposalCount: proposals.length,
      setupWarnings,
    };
  });

function measureCommand<E>(
  action: HermesCommandAction,
  args: ReadonlyArray<string>,
  effect: Effect.Effect<
    {
      readonly exec: ExecResult | null;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly status: HermesCommandStatus;
      readonly nextCommand?: string | null;
    },
    E,
    never
  >,
): Effect.Effect<HermesCommandResult, E, never> {
  return Effect.gen(function* () {
    const startedAt = yield* nowIso();
    const startedMs = yield* Clock.currentTimeMillis;
    const result = yield* effect;
    const finishedAt = yield* nowIso();
    const finishedMs = yield* Clock.currentTimeMillis;
    return commandResult({
      action,
      args,
      exec: result.exec,
      status: result.status,
      stdout: result.stdout ?? result.exec?.stdout ?? "",
      stderr: result.stderr ?? result.exec?.stderr ?? "",
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedMs - startedMs),
      nextCommand: result.nextCommand ?? null,
    });
  });
}

const check: HermesAdapterShape["check"] = () =>
  measureCommand(
    "check",
    ["--version", "doctor", "acp", "--check"],
    getStatus().pipe(
      Effect.map((status) => {
        const approvalBlocked =
          status.config.approvalMode === "off" || status.config.yoloModeDetected;
        const ok =
          status.available && status.doctor.status !== "unavailable" && status.acp.available;
        return {
          exec: null,
          status: ok && !approvalBlocked ? "completed" : "failed",
          stdout: [
            `Hermes: ${status.available ? (status.version ?? "installed") : "unavailable"}`,
            `Doctor: ${status.doctor.status}`,
            `ACP: ${status.acp.available ? "available" : status.acp.check.status}`,
            `Codex OAuth: ${status.codexAuth.source}`,
            `SOUL.md: ${status.soul.exists ? status.soul.summary : "missing"}`,
            `Approval mode: ${status.config.approvalMode}`,
          ].join("\n"),
          stderr: approvalBlocked
            ? "Hermes approval mode is off or HERMES_YOLO_MODE is set. GITS requires manual or smart approvals."
            : "",
        } satisfies {
          readonly exec: ExecResult | null;
          readonly status: HermesCommandStatus;
          readonly stdout: string;
          readonly stderr: string;
        };
      }),
    ),
  );

const setupCodexOAuth: HermesAdapterShape["setupCodexOAuth"] = () =>
  measureCommand(
    "setup-codex-oauth",
    HERMES_CODEX_OAUTH_ARGS,
    Effect.gen(function* () {
      const status = yield* getStatus();
      const soul = yield* Effect.tryPromise({
        try: () => ensureSoul(status.config),
        catch: (cause) => toHermesError("Failed to create GITS Hermes SOUL.md.", cause),
      });
      if (!status.available) {
        return {
          exec: null,
          status: "failed" as const,
          stdout: `Prepared HERMES_HOME at ${status.config.hermesHome}. ${soul.summary}`,
          stderr: "Hermes is not installed or not on PATH.",
          nextCommand:
            "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
        };
      }
      const auth = yield* Effect.tryPromise({
        try: () => readCodexAuthStatus(status.config),
        catch: (cause) => toHermesError("Failed to inspect Codex OAuth state.", cause),
      });
      const nextCommand =
        auth.source === "missing"
          ? `HERMES_HOME=${status.config.hermesHome} hermes auth add openai-codex --type oauth`
          : `HERMES_HOME=${status.config.hermesHome} hermes model`;
      return {
        exec: null,
        status: auth.source === "missing" ? ("action-required" as const) : ("completed" as const),
        stdout: [
          `HERMES_HOME: ${status.config.hermesHome}`,
          soul.summary,
          auth.message,
          "Token contents were not read or copied.",
        ].join("\n"),
        stderr: auth.source === "missing" ? "Codex OAuth re-auth is required." : "",
        nextCommand,
      };
    }),
  );

const startAcpSession: HermesAdapterShape["startAcpSession"] = (input) =>
  measureCommand(
    "start-acp-session",
    HERMES_ACP_START_ARGS,
    execHermes(
      HERMES_ACP_CHECK_ARGS,
      input.cwd === undefined ? undefined : { cwd: input.cwd },
    ).pipe(
      Effect.map((exec) => ({
        exec,
        status: exec.exitCode === 0 ? ("started" as const) : statusFromExec(exec),
        stdout:
          exec.exitCode === 0
            ? [
                exec.stdout,
                "ACP check passed. Launch command prepared for an attached ACP client.",
                "GITS does not keep an unattached stdio ACP process alive.",
              ]
                .filter((line) => line.trim().length > 0)
                .join("\n")
            : exec.stdout,
        stderr: exec.stderr,
        nextCommand: `HERMES_HOME=${resolveHermesHome().hermesHome} hermes acp`,
      })),
    ),
  );

const listSessions: HermesAdapterShape["listSessions"] = (input) =>
  Effect.gen(function* () {
    const limit = input.limit ?? 12;
    const checkedAt = yield* nowIso();
    const result = yield* execHermes(["sessions", "list"]).pipe(
      Effect.mapError((cause: HermesAdapterError) =>
        toHermesError("Failed to list Hermes sessions.", cause),
      ),
    );
    return {
      sessions: parseSessionList(result.stdout, limit),
      checkedAt,
      source: "hermes sessions list",
    } satisfies HermesSessionListResult;
  });

const tailLog: HermesAdapterShape["tailLog"] = (input) =>
  Effect.gen(function* () {
    const config = yield* getConfig();
    const checkedAt = yield* nowIso();
    const lines = input.lines ?? DEFAULT_LOG_LINES;
    const path = yield* Effect.tryPromise({
      try: () => findLogFile(config),
      catch: (cause) => toHermesError("Failed to locate Hermes logs.", cause),
    });
    if (path === null) {
      return {
        path,
        lines,
        text: "No Hermes log file found under HERMES_HOME.",
        checkedAt,
      } satisfies HermesLogTailResult;
    }
    const text = yield* Effect.tryPromise({
      try: () => tailFile(path, lines).then(redactSecrets),
      catch: (cause) => toHermesError("Failed to read Hermes log tail.", cause),
    });
    return {
      path,
      lines,
      text,
      checkedAt,
    } satisfies HermesLogTailResult;
  });

const listProposals: HermesAdapterShape["listProposals"] = () =>
  Effect.gen(function* () {
    const config = yield* getConfig();
    const proposals = yield* Effect.tryPromise({
      try: () => readProposals(config),
      catch: (cause) => toHermesError("Failed to read Hermes proposals.", cause),
    });
    const checkedAt = yield* nowIso();
    return {
      proposals: proposals.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      checkedAt,
    } satisfies HermesProposalListResult;
  });

const inspectGitsAndPropose: HermesAdapterShape["inspectGitsAndPropose"] = (input) =>
  Effect.gen(function* () {
    const config = yield* getConfig();
    yield* Effect.tryPromise({
      try: () => ensureSoul(config),
      catch: (cause) => toHermesError("Failed to create GITS Hermes SOUL.md.", cause),
    });
    const prompt =
      input.prompt ??
      [
        "Inspect this GITS repository read-only and produce exactly one improvement proposal.",
        "Do not edit files. Do not run merge, admin-merge, force-push, delete, or destructive shell commands.",
        "Prefer a proposal that Delamain could execute later in an isolated worktree.",
        "Return a short title, why it matters, scope, risk, and recommended approval path.",
      ].join(" ");
    const exec = yield* execHermes(buildHermesInspectGitsArgs(prompt), {
      cwd: input.projectDir,
      timeoutMs: input.timeoutMs ?? PROPOSAL_TIMEOUT_MS,
    }).pipe(
      Effect.catch((cause: HermesAdapterError) =>
        Effect.succeed({
          stdout: "",
          stderr: cause.message,
          exitCode: null,
          signal: null,
          timedOut: false,
        } satisfies ExecResult),
      ),
    );
    const now = yield* nowIso();
    const detail = nonEmpty(exec.stdout) ?? nonEmpty(exec.stderr) ?? "Hermes returned no proposal.";
    const summary = summarizeProposal(detail);
    const proposal = makeProposal({
      title: summary.title,
      summary: summary.summary,
      detail,
      actionKind: "read-only",
      status: exec.exitCode === 0 ? "proposed" : "blocked",
      blockedReason: exec.exitCode === 0 ? null : "Hermes proposal command did not complete.",
      source: "hermes chat -q",
      projectDir: input.projectDir,
      now,
      evidence: [
        "Hermes was invoked in read-only inspection mode.",
        `Hermes exit code: ${exec.exitCode === null ? "unknown" : String(exec.exitCode)}`,
      ],
    });
    const proposals = yield* Effect.tryPromise({
      try: () => readProposals(config),
      catch: (cause) => toHermesError("Failed to read Hermes proposals.", cause),
    });
    yield* Effect.tryPromise({
      try: () => writeProposals(config, [proposal, ...proposals]),
      catch: (cause) => toHermesError("Failed to persist Hermes proposal.", cause),
    });
    return proposal;
  });

const makeChat =
  (capacityMonitor: GitsCapacityMonitorShape): HermesAdapterShape["chat"] =>
  (input) =>
    Effect.gen(function* () {
      const config = yield* getConfig();
      yield* Effect.tryPromise({
        try: () => ensureSoul(config),
        catch: (cause) => toHermesError("Failed to create GITS Hermes SOUL.md.", cause),
      });
      const actionKind = classifyHermesChatAction(input.message);
      const capacityContext = yield* capacityMonitor.getSnapshot().pipe(
        Effect.map(formatCapacityForHermes),
        Effect.catch(() => Effect.succeed<string | null>(null)),
      );
      const prompt = buildHermesCockpitChatPrompt(input, capacityContext);
      const exec = yield* execHermes(buildHermesCockpitChatArgs(prompt), {
        ...(input.projectDir ? { cwd: input.projectDir } : {}),
        timeoutMs: input.timeoutMs ?? PROPOSAL_TIMEOUT_MS,
      }).pipe(
        Effect.catch((cause: HermesAdapterError) =>
          Effect.succeed({
            stdout: "",
            stderr: cause.message,
            exitCode: null,
            signal: null,
            timedOut: false,
          } satisfies ExecResult),
        ),
      );
      const now = yield* nowIso();
      const detail =
        nonEmpty(exec.stdout) ?? nonEmpty(exec.stderr) ?? "Hermes returned no response.";
      const summary = summarizeProposal(detail);
      const commandBlocked = exec.exitCode !== 0;
      const destructiveBlocked = actionKind === "destructive-shell";
      const proposal = makeProposal({
        title: summary.title,
        summary: summary.summary,
        detail,
        actionKind,
        status: commandBlocked || destructiveBlocked ? "blocked" : "proposed",
        blockedReason: commandBlocked
          ? "Hermes cockpit chat did not complete."
          : destructiveBlocked
            ? "Hermes cannot execute destructive shell requests. Use a human-approved Delamain plan instead."
            : hermesProposalRequiresApproval(actionKind)
              ? "Requires human approval before Delamain spawn, repo write, integrate, or destructive action."
              : null,
        source: "hermes cockpit chat",
        projectDir: input.projectDir ?? null,
        now,
        evidence: [
          "Operator request was classified by GITS before Hermes response.",
          `Classified action kind: ${actionKind}`,
          capacityContext ?? "Provider capacity snapshot unavailable.",
        ],
      });
      const proposals = yield* Effect.tryPromise({
        try: () => readProposals(config),
        catch: (cause) => toHermesError("Failed to read Hermes proposals.", cause),
      });
      yield* Effect.tryPromise({
        try: () => writeProposals(config, [proposal, ...proposals]),
        catch: (cause) => toHermesError("Failed to persist Hermes chat proposal.", cause),
      });
      return proposal;
    });

const decideProposal: HermesAdapterShape["decideProposal"] = (input) =>
  Effect.gen(function* () {
    const config = yield* getConfig();
    const proposals = yield* Effect.tryPromise({
      try: () => readProposals(config),
      catch: (cause) => toHermesError("Failed to read Hermes proposals.", cause),
    });
    const proposal = proposals.find((candidate) => candidate.id === input.proposalId);
    if (!proposal) {
      return yield* toHermesError(`Hermes proposal ${input.proposalId} was not found.`);
    }
    const now = yield* nowIso();
    const nextStatus =
      input.decision === "approve"
        ? "approved"
        : input.decision === "reject"
          ? "rejected"
          : "deferred";
    const blockedReason =
      input.decision === "approve" && hermesDirectExecutionBlocked(proposal.actionKind)
        ? "Approved for handoff only. Hermes cannot execute write, integrate, or destructive actions directly."
        : (input.reason ?? proposal.blockedReason);
    const updated: HermesProposalCard = {
      ...proposal,
      status: nextStatus,
      blockedReason,
      decisionReason: input.reason ?? null,
      decidedAt: now,
      updatedAt: now,
    };
    yield* Effect.tryPromise({
      try: () =>
        writeProposals(
          config,
          proposals.map((candidate) => (candidate.id === input.proposalId ? updated : candidate)),
        ),
      catch: (cause) => toHermesError("Failed to persist Hermes proposal decision.", cause),
    });
    return updated;
  });

function makeWriteProjectContext(
  capacityMonitor: GitsCapacityMonitorShape,
  delamainAdapter: DelamainAdapterShape,
  openGsdAdapter: OpenGsdAdapterShape,
  automodeSupervisor: AutomodeSupervisorShape,
): HermesAdapterShape["writeProjectContext"] {
  return (input) =>
    Effect.gen(function* () {
      const config = yield* getConfig();
      const writtenAt = yield* nowIso();
      const projectId = projectContextId(input.projectDir);
      const targetDir = contextDir(config);
      const targetPath = Path.join(targetDir, `${projectId}.md`);
      const capacitySummary = yield* capacityMonitor.getSnapshot().pipe(
        Effect.map(formatCapacityForHermes),
        Effect.catch((cause: unknown) =>
          Effect.succeed(formatFailureEvidence("Provider capacity", cause)),
        ),
      );
      const delamainSummary = yield* delamainAdapter.listPeers().pipe(
        Effect.map(formatDelamainEvidence),
        Effect.catch((cause: unknown) =>
          Effect.succeed(formatFailureEvidence("Delamain fleet", cause)),
        ),
      );
      const openGsdSummary = yield* openGsdAdapter.getStatus().pipe(
        Effect.map(formatOpenGsdEvidence),
        Effect.catch((cause: unknown) => Effect.succeed(formatFailureEvidence("Open GSD", cause))),
      );
      const automodeSummary = yield* automodeSupervisor.getSnapshot().pipe(
        Effect.map(formatAutomodeEvidence),
        Effect.catch((cause: unknown) => Effect.succeed(formatFailureEvidence("Automode", cause))),
      );
      const markdown = yield* Effect.tryPromise({
        try: () =>
          buildProjectContextMarkdown(input.projectDir, writtenAt, {
            capacitySummary,
            delamainSummary,
            openGsdSummary,
            automodeSummary,
          }),
        catch: (cause) => toHermesError("Failed to build Hermes project context.", cause),
      });
      yield* Effect.tryPromise({
        try: async () => {
          await Fs.mkdir(targetDir, { recursive: true });
          await Fs.writeFile(targetPath, `${markdown}\n`, "utf8");
        },
        catch: (cause) => toHermesError("Failed to write Hermes project context.", cause),
      });
      return {
        projectId,
        projectDir: input.projectDir,
        path: targetPath,
        markdown,
        writtenAt,
      } satisfies HermesProjectContextResult;
    });
}

function draftKindFor(proposal: HermesProposalCard) {
  if (proposal.recommendedExecutor === "open-gsd") {
    return "open-gsd" as const;
  }
  if (proposal.actionKind === "read-only") {
    return "verification" as const;
  }
  return "delamain-peer" as const;
}

const draftFromProposal: HermesAdapterShape["draftFromProposal"] = (input) =>
  Effect.gen(function* () {
    const config = yield* getConfig();
    const proposals = yield* Effect.tryPromise({
      try: () => readProposals(config),
      catch: (cause) => toHermesError("Failed to read Hermes proposals.", cause),
    });
    const proposal = proposals.find((candidate) => candidate.id === input.proposalId);
    if (!proposal) {
      return yield* toHermesError(`Hermes proposal ${input.proposalId} was not found.`);
    }
    const createdAt = yield* nowIso();
    const repo = proposal.projectDir;
    const sourceBranch =
      repo === null
        ? null
        : yield* Effect.tryPromise({
            try: () => execGit(repo, ["branch", "--show-current"]),
            catch: (cause) => toHermesError("Failed to read proposal repo branch.", cause),
          }).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.map((branch) => nonEmpty(branch) ?? null),
          );
    const blockedReason =
      proposal.status !== "approved"
        ? "Only approved proposals can become execution drafts."
        : proposal.actionKind === "destructive-shell"
          ? "Destructive shell proposals are blocked and must be converted manually."
          : repo === null && proposal.actionKind !== "read-only"
            ? "Repo-writing draft requires a selected project root."
            : null;
    const prompt =
      proposal.nextCommandOrPrompt ??
      [
        `Proposal: ${proposal.title}`,
        "",
        proposal.detail,
        "",
        "Evidence:",
        ...proposal.evidence.map((item) => `- ${item}`),
        "",
        "Verification:",
        ...proposal.verificationPlan.map((item) => `- ${item}`),
      ].join("\n");
    return {
      id: `draft-${randomUUID()}`,
      proposalId: proposal.id,
      kind: draftKindFor(proposal),
      status: blockedReason === null ? "draft" : "blocked",
      title: proposal.title,
      repo,
      sourceBranch,
      targetBranch: sourceBranch,
      prompt,
      risk: proposal.risk,
      fileOwnership: proposal.scope,
      verificationCommands: proposal.verificationPlan,
      blockedReason,
      createdAt,
    };
  });

function schedulePrompt(kind: HermesScheduleKind, projectDir: string | null): string {
  const target = projectDir === null ? "configured GITS projects" : projectDir;
  switch (kind) {
    case "daily-briefing":
      return `Create a daily operator briefing for ${target}. Focus on blockers, active work, dirty branches, peer state, and the next three actions.`;
    case "weekly-stale-scan":
      return `Scan ${target} for stale branches, stale PRs, blocked verification, and unclear ownership.`;
    case "tailnet-health":
      return "Check GITS Tailnet hosting health and propose follow-up only if evidence is missing or unhealthy.";
    case "skills-review":
      return "Review GITS Skills Intelligence inventory and propose one skill-port or skill-curation action.";
    case "memory-review":
      return "Review project memory freshness and propose explicit memory updates only when evidence supports them.";
    case "verification-sentinel":
      return `Review whether recent work in ${target} is truly complete against its stated goal and verification evidence.`;
  }
}

const runSchedule: HermesAdapterShape["runSchedule"] = (input) =>
  Effect.gen(function* () {
    const ranAt = yield* nowIso();
    const blockedReason =
      process.env.GITS_MOTOKO_SCHEDULES_DISABLED === "1"
        ? "Motoko scheduled proposal runs are disabled by GITS_MOTOKO_SCHEDULES_DISABLED."
        : null;
    if (blockedReason !== null) {
      return {
        kind: input.kind,
        ranAt,
        proposals: [],
        blockedReason,
      } satisfies HermesScheduleRunResult;
    }
    const proposal = yield* makeChat({
      getSnapshot: () => Effect.die(new Error("Capacity snapshot unavailable for scheduled run.")),
    })({
      message: schedulePrompt(input.kind, input.projectDir ?? null),
      ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    });
    return {
      kind: input.kind,
      ranAt,
      proposals: [proposal],
      blockedReason: null,
    } satisfies HermesScheduleRunResult;
  });

function makeHermesCliAdapterShape(
  capacityMonitor: GitsCapacityMonitorShape,
  delamainAdapter: DelamainAdapterShape,
  openGsdAdapter: OpenGsdAdapterShape,
  automodeSupervisor: AutomodeSupervisorShape,
): HermesAdapterShape {
  return {
    getStatus,
    getConfig,
    check,
    setupCodexOAuth,
    startAcpSession,
    listSessions,
    tailLog,
    listProposals,
    inspectGitsAndPropose,
    chat: makeChat(capacityMonitor),
    decideProposal,
    writeProjectContext: makeWriteProjectContext(
      capacityMonitor,
      delamainAdapter,
      openGsdAdapter,
      automodeSupervisor,
    ),
    draftFromProposal,
    runSchedule,
  };
}

export const makeHermesCliAdapter = Effect.gen(function* () {
  const capacityMonitor = yield* GitsCapacityMonitor;
  const delamainAdapter = yield* DelamainAdapter;
  const openGsdAdapter = yield* OpenGsdAdapter;
  const automodeSupervisor = yield* AutomodeSupervisor;
  return makeHermesCliAdapterShape(
    capacityMonitor,
    delamainAdapter,
    openGsdAdapter,
    automodeSupervisor,
  );
});

export const HermesCliAdapterLive = Layer.effect(HermesAdapter, makeHermesCliAdapter);

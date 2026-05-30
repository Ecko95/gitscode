// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  GitsCockpitError,
  type GitsCockpitProject,
  type GitsCockpitSnapshot,
  type GitsProject,
  type GsdPhase,
  type GsdPhaseStatus,
  type VerificationGate,
  type VerificationGateStatus,
  type YourTurnCard,
  ProjectId,
  type OrchestrationThreadShell,
  type AgentSession,
} from "@t3tools/contracts";

import {
  GitsPlanningScanner,
  type GitsPlanningScanInput,
  type GitsPlanningScannerShape,
} from "../Services/GitsPlanningScanner.ts";

const PHASE_FILE_NAMES = {
  context: "CONTEXT.md",
  spec: "SPEC.md",
  plan: "PLAN.md",
  frozenContract: "FROZEN-CONTRACT.json",
  verification: "VERIFICATION.md",
  summary: "SUMMARY.md",
} as const;

const RISK_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "TODO", pattern: /\bTODO\b/i },
  { label: "FIXME", pattern: /\bFIXME\b/i },
  { label: "WIP", pattern: /\bWIP\b/i },
  { label: "scratch", pattern: /\bscratch\b/i },
  { label: "discussion needed", pattern: /discussion needed/i },
  { label: "needs human review", pattern: /needs human review/i },
  { label: "human review", pattern: /human review/i },
  { label: "manual approval", pattern: /manual approval/i },
  { label: "blocked", pattern: /\bblocked\b/i },
];

const VERIFICATION_FAILURE_PATTERN = /\b(fail|failed|failure|blocked|blocker)\b/i;

interface ScanTarget {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function isNotFoundError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

function toCockpitError(message: string, cause?: unknown) {
  return new GitsCockpitError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function readOptionalFile(filePath: string) {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (cause) {
        if (isNotFoundError(cause)) {
          return null;
        }
        throw cause;
      }
    },
    catch: (cause) => toCockpitError(`Failed to read ${filePath}.`, cause),
  });
}

function readOptionalStats(filePath: string) {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await fs.stat(filePath);
      } catch (cause) {
        if (isNotFoundError(cause)) {
          return null;
        }
        throw cause;
      }
    },
    catch: (cause) => toCockpitError(`Failed to stat ${filePath}.`, cause),
  });
}

function readOptionalDirectory(directoryPath: string) {
  return Effect.tryPromise({
    try: async () => {
      try {
        return await fs.readdir(directoryPath, { withFileTypes: true });
      } catch (cause) {
        if (isNotFoundError(cause)) {
          return null;
        }
        throw cause;
      }
    },
    catch: (cause) => toCockpitError(`Failed to list ${directoryPath}.`, cause),
  });
}

function latestMtimeIso(stats: ReadonlyArray<Stats | null>): string | null {
  const latest = stats.reduce<number | null>((max, stat) => {
    if (stat === null) {
      return max;
    }
    const mtime = stat.mtime.getTime();
    return max === null || mtime > max ? mtime : max;
  }, null);

  return latest === null
    ? null
    : (stats.find((stat) => stat?.mtime.getTime() === latest)?.mtime.toISOString() ?? null);
}

function firstMeaningfulLine(markdown: string | null): string | null {
  if (!markdown) {
    return null;
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/^#+\s*/, "").trim();
    if (line.length > 0) {
      return line.length <= 280 ? line : `${line.slice(0, 277)}...`;
    }
  }
  return null;
}

function clientNameFromProjectMarkdown(markdown: string | null): string | null {
  if (!markdown) {
    return null;
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(?:client|customer)\s*:\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const clientName = match[1]?.trim().replace(/^["']|["']$/g, "");
    return clientName && clientName.length <= 280 ? clientName : null;
  }
  return null;
}

function titleFromPhaseId(id: string): string {
  const withoutPrefix = id.replace(/^\d+(?:[.-]\d+)?[-_.\s]*/, "");
  const readable = withoutPrefix.replaceAll(/[-_]+/g, " ").trim();
  if (!readable) {
    return id;
  }
  return readable.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusFromPhase(input: {
  readonly hasContext: boolean;
  readonly hasSpec: boolean;
  readonly hasPlan: boolean;
  readonly hasVerification: boolean;
  readonly hasSummary: boolean;
  readonly riskFlags: ReadonlyArray<string>;
  readonly verificationContents: string | null;
}): GsdPhaseStatus {
  if (
    input.riskFlags.some((flag) => flag === "blocked") ||
    (input.verificationContents !== null &&
      VERIFICATION_FAILURE_PATTERN.test(input.verificationContents))
  ) {
    return "blocked";
  }
  if (input.hasVerification) {
    return "verified";
  }
  if (input.hasSummary) {
    return "completed";
  }
  if (input.hasPlan) {
    return "planned";
  }
  if (input.hasContext || input.hasSpec) {
    return "discussing";
  }
  return "unknown";
}

function collectRiskFlags(contents: ReadonlyArray<string | null>): string[] {
  const flags = new Set<string>();
  const joined = contents.filter((value): value is string => value !== null).join("\n");
  for (const { label, pattern } of RISK_PATTERNS) {
    if (pattern.test(joined)) {
      flags.add(label);
    }
  }
  return [...flags].toSorted();
}

function directoryNameEntries(entries: ReadonlyArray<Dirent> | null): string[] {
  if (!entries) {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .toSorted();
}

function parseGitConfig(rootPath: string, contents: string | null): GitsProject["repo"] {
  const fallbackName = path.basename(rootPath) || rootPath;
  if (!contents) {
    return {
      id: rootPath,
      name: fallbackName,
      rootPath,
      remoteUrl: null,
      defaultBranch: null,
    };
  }

  let remoteUrl: string | null = null;
  let defaultBranch: string | null = null;
  let inOrigin = false;
  let inBranch = false;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inOrigin = line === '[remote "origin"]';
      inBranch = line.startsWith('[branch "');
      continue;
    }

    if (inOrigin && line.startsWith("url =")) {
      remoteUrl = line.slice("url =".length).trim() || null;
    }

    if (inBranch && line.startsWith("merge = refs/heads/")) {
      defaultBranch = line.slice("merge = refs/heads/".length).trim() || null;
    }
  }

  return {
    id: remoteUrl ?? rootPath,
    name: remoteUrl
      ? (remoteUrl
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .findLast((part) => part.length > 0) ?? fallbackName)
      : fallbackName,
    rootPath,
    remoteUrl,
    defaultBranch,
  };
}

function verificationStatus(contents: string | null): VerificationGateStatus {
  if (contents === null) {
    return "missing";
  }
  return VERIFICATION_FAILURE_PATTERN.test(contents) ? "failed" : "passed";
}

function makeGate(input: {
  readonly projectId: ProjectId;
  readonly phaseId: string;
  readonly label: string;
  readonly status: VerificationGateStatus;
  readonly sourcePath: string | null;
  readonly evidenceSummary: string | null;
}): VerificationGate {
  return {
    id: `${input.phaseId}:${input.label.toLowerCase().replaceAll(/\s+/g, "-")}`,
    projectId: input.projectId,
    phaseId: input.phaseId,
    label: input.label,
    status: input.status,
    sourcePath: input.sourcePath,
    evidenceSummary: input.evidenceSummary,
  };
}

function cardsFromPhase(phase: GsdPhase): YourTurnCard[] {
  const cards: YourTurnCard[] = [];
  if (!phase.hasPlan && (phase.hasContext || phase.hasSpec)) {
    cards.push({
      id: `${phase.projectId}:${phase.id}:missing-plan`,
      projectId: phase.projectId,
      phaseId: phase.id,
      kind: "missing-plan",
      severity: "warning",
      title: `Plan ${phase.title}`,
      detail: "Context or specification exists, but PLAN.md is missing.",
      sourcePath: phase.path,
    });
  }

  if (phase.hasSummary && !phase.hasVerification) {
    cards.push({
      id: `${phase.projectId}:${phase.id}:missing-verification`,
      projectId: phase.projectId,
      phaseId: phase.id,
      kind: "missing-verification",
      severity: "critical",
      title: `Verify ${phase.title}`,
      detail: "SUMMARY.md exists, but VERIFICATION.md is missing.",
      sourcePath: phase.path,
    });
  }

  if (phase.status === "blocked") {
    cards.push({
      id: `${phase.projectId}:${phase.id}:blocked`,
      projectId: phase.projectId,
      phaseId: phase.id,
      kind: "blocked",
      severity: "critical",
      title: `Unblock ${phase.title}`,
      detail: "The phase contains blocked or failed verification language.",
      sourcePath: phase.path,
    });
  }

  if (phase.riskFlags.length > 0) {
    cards.push({
      id: `${phase.projectId}:${phase.id}:risk-flags`,
      projectId: phase.projectId,
      phaseId: phase.id,
      kind: phase.riskFlags.some((flag) => flag.includes("human")) ? "human-review" : "risk-flag",
      severity: "warning",
      title: `Review ${phase.title}`,
      detail: `Flagged terms: ${phase.riskFlags.join(", ")}.`,
      sourcePath: phase.path,
    });
  }

  return cards;
}

function cardsFromThreads(
  project: ScanTarget,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): YourTurnCard[] {
  return threads.flatMap((thread) => {
    if (thread.projectId !== project.id) {
      return [];
    }

    const cards: YourTurnCard[] = [];
    if (thread.hasPendingApprovals) {
      cards.push({
        id: `${project.id}:${thread.id}:approval`,
        projectId: project.id,
        phaseId: null,
        kind: "approval",
        severity: "critical",
        title: thread.title,
        detail: "This thread has a pending approval request.",
        sourcePath: thread.worktreePath ?? project.workspaceRoot,
      });
    }

    if (thread.hasPendingUserInput) {
      cards.push({
        id: `${project.id}:${thread.id}:user-input`,
        projectId: project.id,
        phaseId: null,
        kind: "approval",
        severity: "warning",
        title: thread.title,
        detail: "This thread is waiting for user input.",
        sourcePath: thread.worktreePath ?? project.workspaceRoot,
      });
    }

    return cards;
  });
}

function sessionsFromThreads(
  project: ScanTarget,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): AgentSession[] {
  return threads.flatMap((thread) => {
    if (thread.projectId !== project.id || thread.session === null) {
      return [];
    }

    return [
      {
        id: `${thread.id}:${thread.session.providerInstanceId ?? thread.modelSelection.instanceId}`,
        projectId: project.id,
        threadId: thread.id,
        provider:
          thread.session.providerName ??
          thread.session.providerInstanceId ??
          thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
        status: thread.session.status,
        cwd: project.workspaceRoot,
        worktreePath: thread.worktreePath,
        lastActivityAt: thread.session.updatedAt,
      },
    ];
  });
}

function scanPhase(projectId: ProjectId, phaseDirectory: string, phaseId: string) {
  return Effect.gen(function* () {
    const contextPath = path.join(phaseDirectory, PHASE_FILE_NAMES.context);
    const specPath = path.join(phaseDirectory, PHASE_FILE_NAMES.spec);
    const planPath = path.join(phaseDirectory, PHASE_FILE_NAMES.plan);
    const frozenContractPath = path.join(phaseDirectory, PHASE_FILE_NAMES.frozenContract);
    const verificationPath = path.join(phaseDirectory, PHASE_FILE_NAMES.verification);
    const summaryPath = path.join(phaseDirectory, PHASE_FILE_NAMES.summary);

    const [context, spec, plan, frozenContract, verification, summary] = yield* Effect.all(
      [
        readOptionalFile(contextPath),
        readOptionalFile(specPath),
        readOptionalFile(planPath),
        readOptionalFile(frozenContractPath),
        readOptionalFile(verificationPath),
        readOptionalFile(summaryPath),
      ],
      { concurrency: "unbounded" },
    );
    const stats = yield* Effect.all(
      [
        readOptionalStats(contextPath),
        readOptionalStats(specPath),
        readOptionalStats(planPath),
        readOptionalStats(frozenContractPath),
        readOptionalStats(verificationPath),
        readOptionalStats(summaryPath),
      ],
      { concurrency: "unbounded" },
    );

    const riskFlags = collectRiskFlags([context, spec, plan, verification, summary]);
    const phase: GsdPhase = {
      id: phaseId,
      title: titleFromPhaseId(phaseId),
      projectId,
      path: phaseDirectory,
      status: statusFromPhase({
        hasContext: context !== null,
        hasSpec: spec !== null,
        hasPlan: plan !== null,
        hasVerification: verification !== null,
        hasSummary: summary !== null,
        riskFlags,
        verificationContents: verification,
      }),
      hasContext: context !== null,
      hasSpec: spec !== null,
      hasPlan: plan !== null,
      hasFrozenContract: frozenContract !== null,
      hasVerification: verification !== null,
      hasSummary: summary !== null,
      riskFlags,
      updatedAt: latestMtimeIso(stats),
    };

    const gates: VerificationGate[] = [
      makeGate({
        projectId,
        phaseId,
        label: "Plan",
        status: plan === null ? "missing" : "passed",
        sourcePath: plan === null ? null : planPath,
        evidenceSummary: firstMeaningfulLine(plan),
      }),
      makeGate({
        projectId,
        phaseId,
        label: "Verification",
        status: verificationStatus(verification),
        sourcePath: verification === null ? null : verificationPath,
        evidenceSummary: firstMeaningfulLine(verification),
      }),
    ];

    if (frozenContract !== null) {
      gates.push(
        makeGate({
          projectId,
          phaseId,
          label: "Frozen contract",
          status: "passed",
          sourcePath: frozenContractPath,
          evidenceSummary: "Frozen execution contract present.",
        }),
      );
    }

    return {
      phase,
      gates,
      yourTurn: cardsFromPhase(phase),
    };
  });
}

function scanProject(
  target: ScanTarget,
  threads: ReadonlyArray<OrchestrationThreadShell>,
  scannedAt: string,
) {
  return Effect.gen(function* () {
    const planningPath = path.join(target.workspaceRoot, ".planning");
    const planningEntries = yield* readOptionalDirectory(planningPath);
    const hasPlanning = planningEntries !== null;
    const phaseEntries = yield* readOptionalDirectory(path.join(planningPath, "phases"));
    const milestoneEntries = yield* readOptionalDirectory(path.join(planningPath, "milestones"));
    const phaseIds = directoryNameEntries(phaseEntries);
    const gitConfig = yield* readOptionalFile(path.join(target.workspaceRoot, ".git", "config"));
    const projectMarkdown = yield* readOptionalFile(path.join(planningPath, "PROJECT.md"));
    const phaseResults = yield* Effect.forEach(
      phaseIds,
      (phaseId) => scanPhase(target.id, path.join(planningPath, "phases", phaseId), phaseId),
      { concurrency: 4 },
    );

    const phases = phaseResults.map((result) => result.phase);
    const verificationGates = phaseResults.flatMap((result) => result.gates);
    const planningWarnings: string[] = [];

    if (!hasPlanning) {
      planningWarnings.push(".planning directory is missing.");
    } else if (phaseEntries === null) {
      planningWarnings.push(".planning/phases directory is missing.");
    }

    const project: GitsProject = {
      id: target.id,
      title: target.title,
      rootPath: target.workspaceRoot,
      clientName: clientNameFromProjectMarkdown(projectMarkdown),
      repo: parseGitConfig(target.workspaceRoot, gitConfig),
      planning: {
        state: hasPlanning ? (phaseEntries === null ? "partial" : "present") : "absent",
        path: hasPlanning ? planningPath : null,
        phaseCount: phases.length,
        milestoneCount: directoryNameEntries(milestoneEntries).length,
        warnings: planningWarnings,
        lastScannedAt: scannedAt,
      },
    };

    const planningCards: YourTurnCard[] = hasPlanning
      ? []
      : [
          {
            id: `${target.id}:missing-planning`,
            projectId: target.id,
            phaseId: null,
            kind: "missing-planning",
            severity: "info",
            title: `${target.title} planning`,
            detail: ".planning is not present for this project.",
            sourcePath: target.workspaceRoot,
          },
        ];

    const cockpitProject: GitsCockpitProject = {
      project,
      phases,
      verificationGates,
      agentSessions: sessionsFromThreads(target, threads),
      peers: [],
      goals: [],
      yourTurn: [
        ...planningCards,
        ...phaseResults.flatMap((result) => result.yourTurn),
        ...cardsFromThreads(target, threads),
      ],
    };

    return cockpitProject;
  });
}

function toScanTargets(input: GitsPlanningScanInput): ScanTarget[] {
  if (input.projects.length > 0) {
    return input.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    }));
  }

  return [
    {
      id: ProjectId.make(`cwd:${input.fallbackCwd}`),
      title: path.basename(input.fallbackCwd) || "Current workspace",
      workspaceRoot: input.fallbackCwd,
    },
  ];
}

function buildTotals(projects: ReadonlyArray<GitsCockpitProject>): GitsCockpitSnapshot["totals"] {
  return {
    projectCount: projects.length,
    planningProjectCount: projects.filter((project) => project.project.planning.state !== "absent")
      .length,
    phaseCount: projects.reduce((sum, project) => sum + project.phases.length, 0),
    verificationGateCount: projects.reduce(
      (sum, project) => sum + project.verificationGates.length,
      0,
    ),
    pendingYourTurnCount: projects.reduce((sum, project) => sum + project.yourTurn.length, 0),
    activeAgentSessionCount: projects.reduce(
      (sum, project) =>
        sum +
        project.agentSessions.filter(
          (session) =>
            session.status === "starting" ||
            session.status === "running" ||
            session.status === "ready",
        ).length,
      0,
    ),
    peerCount: projects.reduce((sum, project) => sum + project.peers.length, 0),
  };
}

const makeGitsPlanningScannerShape = {
  scan: (input) =>
    Effect.gen(function* () {
      const scannedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const projects = yield* Effect.forEach(
        toScanTargets(input),
        (target) => scanProject(target, input.threads, scannedAt),
        { concurrency: 4 },
      );

      return {
        scannedAt,
        projects,
        totals: buildTotals(projects),
      };
    }),
} satisfies GitsPlanningScannerShape;

export const makeGitsPlanningScanner = Effect.succeed(makeGitsPlanningScannerShape);

export const GitsPlanningScannerLive = Layer.effect(GitsPlanningScanner, makeGitsPlanningScanner);

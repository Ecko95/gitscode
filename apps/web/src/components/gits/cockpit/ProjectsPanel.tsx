import type {
  AgentSession,
  GitsCockpitProject,
  GitsCockpitSnapshot,
  GsdPhase,
  VerificationGate,
  YourTurnCard,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleIcon,
  GitBranchIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";

import {
  EmptyState,
  GATE_STATUS_LABELS,
  PHASE_STATUS_LABELS,
  SectionHeader,
  StatBlock,
  StatusPill,
  formatCount,
  statusTone,
} from "./primitives";

function YourTurnList({ cards }: { cards: ReadonlyArray<YourTurnCard> }) {
  if (cards.length === 0) {
    return <EmptyState label="No current handoff cards." />;
  }

  return (
    <div className="divide-y divide-border/60">
      {cards.slice(0, 6).map((card) => (
        <div key={card.id} className="grid gap-1 px-4 py-3 text-xs sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangleIcon
              className={cn(
                "size-3.5 shrink-0",
                card.severity === "critical" ? "text-destructive" : "text-amber-500",
              )}
            />
            <span className="truncate font-medium text-foreground">{card.title}</span>
            <StatusPill label={card.kind.replaceAll("-", " ")} tone="warning" />
          </div>
          <p className="line-clamp-2 text-muted-foreground">{card.detail}</p>
        </div>
      ))}
    </div>
  );
}

function PhaseTable({ phases }: { phases: ReadonlyArray<GsdPhase> }) {
  if (phases.length === 0) {
    return <EmptyState label="No phase directories found." />;
  }

  return (
    <ScrollArea chainVerticalScroll scrollFade hideScrollbars className="w-full">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="border-b border-border/60 text-[11px] uppercase text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-medium sm:px-5">Phase</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Artifacts</th>
            <th className="px-3 py-2 font-medium">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {phases.map((phase) => (
            <tr key={phase.id}>
              <td className="min-w-0 px-4 py-2.5 sm:px-5">
                <div className="font-medium text-foreground">{phase.title}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{phase.id}</div>
              </td>
              <td className="px-3 py-2.5">
                <StatusPill
                  label={PHASE_STATUS_LABELS[phase.status]}
                  tone={statusTone(phase.status)}
                />
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {[
                  phase.hasContext ? "context" : null,
                  phase.hasSpec ? "spec" : null,
                  phase.hasPlan ? "plan" : null,
                  phase.hasFrozenContract ? "frozen" : null,
                  phase.hasVerification ? "verification" : null,
                  phase.hasSummary ? "summary" : null,
                ]
                  .filter(Boolean)
                  .join(", ") || "none"}
              </td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {phase.riskFlags.length > 0 ? phase.riskFlags.join(", ") : "none"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function GateList({ gates }: { gates: ReadonlyArray<VerificationGate> }) {
  if (gates.length === 0) {
    return <EmptyState label="No verification gates found." />;
  }

  return (
    <div className="divide-y divide-border/60">
      {gates.slice(0, 8).map((gate) => (
        <div key={gate.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5">
          <ShieldCheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{gate.label}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {gate.evidenceSummary ?? gate.phaseId ?? "Project gate"}
            </div>
          </div>
          <StatusPill label={GATE_STATUS_LABELS[gate.status]} tone={statusTone(gate.status)} />
        </div>
      ))}
    </div>
  );
}

function AgentSessionList({ sessions }: { sessions: ReadonlyArray<AgentSession> }) {
  if (sessions.length === 0) {
    return <EmptyState label="No active provider sessions." />;
  }

  return (
    <div className="divide-y divide-border/60">
      {sessions.map((session) => (
        <div key={session.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5 sm:px-5">
          <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{session.provider}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {session.model ?? "No model"} | {session.worktreePath ?? session.cwd}
            </div>
          </div>
          <StatusPill label={session.status} tone={statusTone(session.status)} />
        </div>
      ))}
    </div>
  );
}

function ProjectPanel({ project }: { project: GitsCockpitProject }) {
  return (
    <section className="overflow-hidden border-b border-border bg-background">
      <div className="flex flex-col gap-2 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">{project.project.title}</h2>
            <StatusPill
              label={project.project.planning.state}
              tone={project.project.planning.state === "present" ? "success" : "warning"}
            />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {project.project.clientName ? <span>{project.project.clientName}</span> : null}
            <span className="truncate font-mono">{project.project.rootPath}</span>
            {project.project.repo.remoteUrl ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <GitBranchIcon className="size-3 shrink-0" />
                <span className="truncate">{project.project.repo.remoteUrl}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 text-right text-xs sm:w-72">
          <div>
            <div className="font-mono font-semibold">
              {formatCount(project.project.planning.milestoneCount)}
            </div>
            <div className="text-muted-foreground">milestones</div>
          </div>
          <div>
            <div className="font-mono font-semibold">{formatCount(project.phases.length)}</div>
            <div className="text-muted-foreground">phases</div>
          </div>
          <div>
            <div className="font-mono font-semibold">
              {formatCount(project.verificationGates.length)}
            </div>
            <div className="text-muted-foreground">gates</div>
          </div>
          <div>
            <div className="font-mono font-semibold">{formatCount(project.yourTurn.length)}</div>
            <div className="text-muted-foreground">turns</div>
          </div>
        </div>
      </div>

      {project.project.planning.warnings.length > 0 ? (
        <div className="border-b border-border/60 bg-amber-500/8 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 sm:px-5">
          {project.project.planning.warnings.join(" ")}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
        <div className="min-w-0 border-r border-border/60">
          <SectionHeader title="GSD phases" count={project.phases.length} />
          <PhaseTable phases={project.phases} />
        </div>
        <div className="min-w-0 divide-y divide-border/60">
          <div>
            <SectionHeader title="Your Turn" count={project.yourTurn.length} />
            <YourTurnList cards={project.yourTurn} />
          </div>
          <div>
            <SectionHeader title="Verification gates" count={project.verificationGates.length} />
            <GateList gates={project.verificationGates} />
          </div>
          <div>
            <SectionHeader title="Agent sessions" count={project.agentSessions.length} />
            <AgentSessionList sessions={project.agentSessions} />
          </div>
        </div>
      </div>
    </section>
  );
}

export function CockpitContent({ snapshot }: { snapshot: GitsCockpitSnapshot }) {
  return (
    <>
      <div className="grid grid-cols-2 border-b border-border/60 sm:grid-cols-4 xl:grid-cols-7">
        <StatBlock
          label="Projects"
          value={formatCount(snapshot.totals.projectCount)}
          icon={CircleIcon}
        />
        <StatBlock
          label="Planning"
          value={formatCount(snapshot.totals.planningProjectCount)}
          icon={CheckCircle2Icon}
        />
        <StatBlock
          label="Phases"
          value={formatCount(snapshot.totals.phaseCount)}
          icon={GitBranchIcon}
        />
        <StatBlock
          label="Gates"
          value={formatCount(snapshot.totals.verificationGateCount)}
          icon={ShieldCheckIcon}
        />
        <StatBlock
          label="Your Turn"
          value={formatCount(snapshot.totals.pendingYourTurnCount)}
          icon={AlertTriangleIcon}
        />
        <StatBlock
          label="Agents"
          value={formatCount(snapshot.totals.activeAgentSessionCount)}
          icon={BotIcon}
        />
        <StatBlock label="Peers" value={formatCount(snapshot.totals.peerCount)} icon={CircleIcon} />
      </div>

      {snapshot.projects.length === 0 ? (
        <div className="px-5 py-8 text-sm text-muted-foreground">No projects registered.</div>
      ) : (
        snapshot.projects.map((project) => (
          <ProjectPanel key={project.project.id} project={project} />
        ))
      )}
    </>
  );
}

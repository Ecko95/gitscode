import type {
  DelamainPeer,
  GitsCapacitySnapshot,
  GitsCockpitProject,
  HermesChatResult,
  HermesCommandResult,
  HermesExecutionDraft,
  HermesLogTailResult,
  HermesProposalCard,
  HermesProposalListResult,
  HermesScheduleKind,
  HermesScheduleRunResult,
  HermesSessionListResult,
  HermesStatusResult,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ArrowUpIcon,
  BotIcon,
  CheckCircle2Icon,
  CopyIcon,
  FilePlus2Icon,
  GaugeIcon,
  GitBranchIcon,
  ListChecksIcon,
  LockIcon,
  MessageSquarePlusIcon,
  PlayIcon,
  PowerIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Separator } from "~/components/ui/separator";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ComposerVoiceButton } from "~/components/chat/ComposerVoiceButton";
import { useVoiceTranscription } from "~/hooks/useVoiceTranscription";

import {
  EmptyState,
  SectionHeader,
  StatBlock,
  StatusPill,
  formatCount,
  formatIsoDate,
  formatTokenLimit,
  isRecord,
  statusTone,
} from "./primitives";
import {
  computeRestorableAfterSend,
  isNearBottom,
  visibleTranscriptWindow,
} from "./motoko/motoko.logic";

function hermesCommandResultTone(
  status: HermesCommandResult["status"],
): ReturnType<typeof statusTone> {
  if (status === "completed" || status === "started") {
    return "success";
  }
  if (status === "action-required" || status === "timed-out") {
    return "warning";
  }
  return "danger";
}

function hermesProposalTone(status: HermesProposalCard["status"]): ReturnType<typeof statusTone> {
  if (status === "approved" || status === "drafted") {
    return "success";
  }
  if (status === "blocked" || status === "rejected") {
    return "danger";
  }
  if (status === "deferred") {
    return "default";
  }
  return "warning";
}

const MOTOKO_SCHEDULE_OPTIONS: ReadonlyArray<{
  readonly value: HermesScheduleKind;
  readonly label: string;
}> = [
  { value: "daily-briefing", label: "Daily briefing" },
  { value: "weekly-stale-scan", label: "Weekly stale scan" },
  { value: "tailnet-health", label: "Tailnet health" },
  { value: "skills-review", label: "Skills review" },
  { value: "memory-review", label: "Memory review" },
  { value: "verification-sentinel", label: "Verification sentinel" },
];

const MOTOKO_CAPSULE_FRAME_SRC = "/gits/motoko-capsule-frame.png";
const MOTOKO_CAPSULE_VIDEO_SRC = "/gits/motoko-capsule-avatar.mp4";
const MOTOKO_CHAT_LOGO_SRC = "/gits/motoko-chat-logo.png";
export const MOTOKO_ROOT_ROUTE_VALUE = "";
const MOTOKO_ROOT_ROUTE_SELECT_VALUE = "__root_gits__";
const MOTOKO_ROOT_ROUTE_LABEL = "root/gits";
const MOTOKO_SUPERVISED_DESCRIPTION = "Ask before commands and file changes.";
const MOTOKO_CAPSULE_VIDEO_WINDOW_STYLE = {
  height: "49.8%",
  left: "25.1%",
  top: "24.3%",
  width: "49.8%",
};
const MOTOKO_PROPOSAL_RAIL_LIMIT = 3;

export type MotokoInteractionMode = "default" | "plan";

export interface MotokoTranscriptEntry {
  readonly id: string;
  readonly role: "operator" | "motoko";
  readonly message: string;
  readonly createdAt: string;
  readonly result?: HermesChatResult;
}

export function makeTranscriptEntryId(
  role: MotokoTranscriptEntry["role"],
  createdAt: string,
): string {
  return `${role}:${createdAt}:${Math.floor(performance.now() * 1000)}`;
}

function motokoProjectRouteLabel(project: GitsCockpitProject): string {
  return `${project.project.title} | ${project.project.rootPath}`;
}

export function motokoSelectedRouteLabel(selectedProjectRoot: string): string {
  return selectedProjectRoot.trim().length === 0 ? MOTOKO_ROOT_ROUTE_LABEL : selectedProjectRoot;
}

export const EMPTY_MOTOKO_TRANSCRIPT: ReadonlyArray<MotokoTranscriptEntry> = [];

export type MotokoProposalDecision = "approve" | "reject" | "defer";

const MOTOKO_TRANSCRIPTS_STORAGE_KEY = "gits:motoko:transcripts:v1";
const MOTOKO_TRANSCRIPT_PERSIST_LIMIT = 200;

export type MotokoTranscriptState = Readonly<Record<string, ReadonlyArray<MotokoTranscriptEntry>>>;

export function loadMotokoTranscripts(): MotokoTranscriptState {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(MOTOKO_TRANSCRIPTS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const transcripts: Record<string, ReadonlyArray<MotokoTranscriptEntry>> = {};
    for (const [routeKey, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        continue;
      }
      transcripts[routeKey] = entries.filter(
        (entry): entry is MotokoTranscriptEntry =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          (entry.role === "operator" || entry.role === "motoko") &&
          typeof entry.message === "string" &&
          typeof entry.createdAt === "string",
      );
    }
    return transcripts;
  } catch {
    return {};
  }
}

export function saveMotokoTranscripts(transcripts: MotokoTranscriptState): void {
  if (typeof window === "undefined") {
    return;
  }
  const bounded = Object.fromEntries(
    Object.entries(transcripts)
      .filter(([, entries]) => entries.length > 0)
      .map(([routeKey, entries]) => [routeKey, entries.slice(-MOTOKO_TRANSCRIPT_PERSIST_LIMIT)]),
  );
  try {
    window.localStorage.setItem(MOTOKO_TRANSCRIPTS_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Quota or private-mode failure: keep the in-memory transcript, drop persistence.
  }
}

const MOTOKO_PROPOSAL_STATUS_ACCENT: Record<HermesProposalCard["status"], string> = {
  proposed: "border-l-amber-500/60",
  approved: "border-l-emerald-500/60",
  drafted: "border-l-emerald-500/60",
  rejected: "border-l-destructive/60",
  blocked: "border-l-destructive/60",
  deferred: "border-l-border",
};

// Mirrors the server's draftKindFor so the card can announce what approval will do.
function motokoProposalDraftKind(
  proposal: HermesProposalCard,
): "delamain-peer" | "open-gsd" | "verification" {
  if (proposal.recommendedExecutor === "open-gsd") {
    return "open-gsd";
  }
  if (proposal.actionKind === "read-only") {
    return "verification";
  }
  return "delamain-peer";
}

export function motokoDecisionSummary(
  decision: MotokoProposalDecision,
  title: string,
  result: {
    decided: HermesProposalCard;
    draft: HermesExecutionDraft | null;
    peer: DelamainPeer | null;
  },
): string {
  if (decision === "reject") {
    return `Rejected proposal "${title}".`;
  }
  if (decision === "defer") {
    return `Deferred proposal "${title}".`;
  }
  if (result.peer) {
    return `Approved "${title}" and dispatched Delamain peer ${result.peer.name ?? result.peer.id} on ${result.draft?.repo ?? "the proposal repo"}.`;
  }
  if (result.draft === null) {
    return `Approved "${title}" (status: ${result.decided.status}).`;
  }
  if (result.draft.status === "blocked") {
    return `Approved "${title}" but nothing was dispatched: ${result.draft.blockedReason ?? "the execution draft is blocked"}.`;
  }
  return `Approved "${title}" and created a ${result.draft.kind} handoff draft.`;
}

function MotokoProposalCardList({ label, items }: { label: string; items: ReadonlyArray<string> }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground/80">{label}</div>
      <ul className="grid gap-1 text-[11px] text-muted-foreground">
        {items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines can repeat; index keeps keys unique
          <li key={`${label}-${index}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MotokoProposalCard({
  proposal,
  actionPending,
  onDecision,
  onDraft,
  compact = false,
}: {
  proposal: HermesProposalCard;
  actionPending: boolean;
  onDecision: (proposal: HermesProposalCard, decision: MotokoProposalDecision) => void;
  onDraft: (proposalId: string) => void;
  compact?: boolean;
}) {
  const draftKind = motokoProposalDraftKind(proposal);
  const canApprove =
    proposal.status === "proposed" ||
    proposal.status === "deferred" ||
    proposal.status === "rejected";
  const canReject = proposal.status === "proposed" || proposal.status === "deferred";
  const canDefer = proposal.status === "proposed" || proposal.status === "blocked";
  const canDraft = proposal.status === "approved";
  const hasDetails =
    !compact &&
    (proposal.detail.trim().length > 0 ||
      proposal.evidence.length > 0 ||
      proposal.verificationPlan.length > 0 ||
      proposal.scope.length > 0);
  return (
    <article
      className={cn(
        "grid gap-2.5 rounded-lg border border-border/70 border-l-2 bg-card/80 px-3.5 py-3 text-xs shadow-xs",
        MOTOKO_PROPOSAL_STATUS_ACCENT[proposal.status],
      )}
    >
      <header className="grid gap-1.5">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground">
            {proposal.title}
          </span>
          <StatusPill label={proposal.status} tone={hermesProposalTone(proposal.status)} />
        </div>
        {compact ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <StatusPill
              label={`risk ${proposal.risk}`}
              tone={proposal.risk === "blocked" ? "danger" : "default"}
            />
            <span>{proposal.actionKind}</span>
            <span aria-hidden="true">|</span>
            <span>
              {draftKind === "delamain-peer"
                ? "approval dispatches a Delamain peer"
                : draftKind === "open-gsd"
                  ? "approval drafts an Open GSD handoff"
                  : "approval drafts a verification handoff"}
            </span>
            {proposal.projectDir ? (
              <>
                <span aria-hidden="true">|</span>
                <span className="min-w-0 truncate font-mono">{proposal.projectDir}</span>
              </>
            ) : null}
          </div>
        )}
      </header>
      <p className={cn("leading-relaxed text-muted-foreground", compact && "line-clamp-2")}>
        {proposal.summary}
      </p>
      {hasDetails ? (
        <details className="overflow-hidden rounded-md border border-border/60 bg-background/70">
          <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            Details, evidence & verification
          </summary>
          <div className="grid gap-3 border-t border-border/60 px-3 py-3">
            {proposal.detail.trim().length > 0 ? (
              <p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">
                {proposal.detail}
              </p>
            ) : null}
            <MotokoProposalCardList label="Evidence" items={proposal.evidence} />
            <MotokoProposalCardList label="Verification plan" items={proposal.verificationPlan} />
            <MotokoProposalCardList label="Scope" items={proposal.scope} />
          </div>
        </details>
      ) : null}
      {proposal.blockedReason ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {proposal.blockedReason}
        </div>
      ) : null}
      {proposal.decisionReason ? (
        <div className="text-[11px] text-muted-foreground">
          Decision note: {proposal.decisionReason}
        </div>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {proposal.decidedAt
            ? `decided ${formatIsoDate(proposal.decidedAt)}`
            : `proposed ${formatIsoDate(proposal.createdAt)}`}
        </span>
        <div className="flex flex-wrap justify-end gap-2">
          {canDefer ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDecision(proposal, "defer")}
              disabled={actionPending}
            >
              Defer
            </Button>
          ) : null}
          {canReject ? (
            <Button
              size="sm"
              variant="destructive-outline"
              onClick={() => onDecision(proposal, "reject")}
              disabled={actionPending}
            >
              Reject
            </Button>
          ) : null}
          {canApprove ? (
            <Button
              size="sm"
              onClick={() => onDecision(proposal, "approve")}
              disabled={actionPending}
            >
              <CheckCircle2Icon className="size-3.5" />
              {draftKind === "delamain-peer" ? "Approve & dispatch" : "Approve"}
            </Button>
          ) : null}
          {canDraft ? (
            <Button size="sm" onClick={() => onDraft(proposal.id)} disabled={actionPending}>
              <FilePlus2Icon className="size-3.5" />
              Draft handoff
            </Button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

function motokoModelBadgeLabel(status: HermesStatusResult | undefined): string {
  const provider = status?.model.provider;
  const model = status?.model.model ?? "model setup";
  return provider ? `${provider}/${model}` : model;
}

/** Was a live Select bound to a single non-selectable item (audit: misleading affordance).
 *  Now a plain badge; the context-window detail lives in its tooltip. */
function MotokoModelBadge({ status }: { status: HermesStatusResult | undefined }) {
  const provider = status?.model.provider ?? "Hermes";
  const contextWindowLabel = formatTokenLimit(status?.model.contextWindowTokens);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span tabIndex={0} className="inline-flex shrink-0 cursor-default outline-none">
            <Badge
              variant="outline"
              className="gap-1 rounded-full border-border/70 bg-muted/24 px-2.5 py-1 font-medium text-muted-foreground/80"
            >
              <SparklesIcon className="size-3" />
              {motokoModelBadgeLabel(status)}
            </Badge>
          </span>
        }
      />
      <TooltipPopup>
        {provider} | context {contextWindowLabel}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Was a live Select locked to one option with a no-op onValueChange (audit: misleading
 *  affordance). Motoko only ever runs supervised, so this is now a plain status pill. */
function MotokoSupervisedPill() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span tabIndex={0} className="inline-flex shrink-0 cursor-default outline-none">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-muted/24 px-2.5 text-[11px] font-medium text-muted-foreground">
              <LockIcon className="size-3.5" />
              Supervised
            </span>
          </span>
        }
      />
      <TooltipPopup>{MOTOKO_SUPERVISED_DESCRIPTION}</TooltipPopup>
    </Tooltip>
  );
}

function MotokoFooterModeControls({
  interactionMode,
  onToggleInteractionMode,
}: {
  interactionMode: MotokoInteractionMode;
  onToggleInteractionMode: () => void;
}) {
  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Button
        variant="ghost"
        className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
        size="sm"
        type="button"
        onClick={onToggleInteractionMode}
        title={
          interactionMode === "plan"
            ? "Plan mode - click to return to build mode"
            : "Build mode - click to enter plan mode"
        }
      >
        <BotIcon />
        <span className="sr-only sm:not-sr-only">
          {interactionMode === "plan" ? "Plan" : "Build"}
        </span>
      </Button>

      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <MotokoSupervisedPill />
    </>
  );
}

function MotokoContextWindowChip({ status }: { status: HermesStatusResult | undefined }) {
  return (
    <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/24 px-2.5 text-[11px] font-medium text-muted-foreground">
      <GaugeIcon className="size-3.5" />
      <span className="tabular-nums">{formatTokenLimit(status?.model.contextWindowTokens)}</span>
    </span>
  );
}

function MotokoChatComposer({
  status,
  projects,
  selectedProjectRoot,
  value,
  interactionMode,
  actionPending,
  onToggleInteractionMode,
  onProjectRootChange,
  onValueChange,
  onSubmit,
  textareaRef,
}: {
  status: HermesStatusResult | undefined;
  projects: ReadonlyArray<GitsCockpitProject>;
  selectedProjectRoot: string;
  value: string;
  interactionMode: MotokoInteractionMode;
  actionPending: boolean;
  onToggleInteractionMode: () => void;
  onProjectRootChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const canSend = !actionPending && value.trim().length > 0;
  const chatInputRef = useRef(value);
  chatInputRef.current = value;
  const voiceTranscription = useVoiceTranscription({
    onTranscript: (text) => {
      const current = chatInputRef.current;
      onValueChange(current.trim().length > 0 ? `${current} ${text}` : text);
    },
  });
  const routeItems = useMemo(
    () => [
      { value: MOTOKO_ROOT_ROUTE_SELECT_VALUE, label: MOTOKO_ROOT_ROUTE_LABEL },
      ...projects.map((project) => ({
        value: project.project.rootPath,
        label: motokoProjectRouteLabel(project),
      })),
    ],
    [projects],
  );
  const selectedRouteValue =
    selectedProjectRoot.trim().length === 0 ? MOTOKO_ROOT_ROUTE_SELECT_VALUE : selectedProjectRoot;

  const submit = () => {
    if (canSend) {
      onSubmit();
    }
  };

  return (
    <form
      className="mx-auto w-full max-w-208"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="rounded-[22px] border border-border/70 bg-card p-px shadow-[0_18px_44px_rgba(0,0,0,0.24)] transition-colors has-focus-within:border-ring/45">
        <div className="overflow-hidden rounded-[20px] border border-border/60 bg-background/96">
          <div className="px-3 pt-3.5 sm:px-4 sm:pt-4">
            <textarea
              ref={textareaRef}
              value={value}
              placeholder="Ask Motoko"
              className="min-h-24 w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/45 sm:min-h-28"
              rows={3}
              onChange={(event) => onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <div
            data-chat-composer-footer="true"
            className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible border-t border-border/55 px-2.5 pb-2.5 pt-2.5 sm:px-3"
          >
            <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="min-w-48 max-w-72 shrink-0">
                <Select
                  modal={false}
                  value={selectedRouteValue}
                  items={routeItems}
                  onValueChange={(value) => {
                    if (typeof value !== "string") {
                      return;
                    }
                    onProjectRootChange(
                      value === MOTOKO_ROOT_ROUTE_SELECT_VALUE ? MOTOKO_ROOT_ROUTE_VALUE : value,
                    );
                  }}
                >
                  <SelectTrigger
                    aria-label="Motoko route"
                    variant="ghost"
                    size="sm"
                    className="min-h-8 w-full min-w-0 rounded-full border border-border/70 bg-muted/24 px-3 py-1.5 text-foreground shadow-none transition-colors hover:bg-accent focus-visible:border-ring/45 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/24 sm:min-h-8"
                  >
                    <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                    <SelectValue className="min-w-0 font-mono text-[11px]" />
                  </SelectTrigger>
                  <SelectPopup
                    className="max-h-72"
                    popupClassName="max-w-[min(34rem,calc(100vw-2rem))]"
                  >
                    <SelectGroup>
                      <SelectGroupLabel>Motoko route</SelectGroupLabel>
                      <SelectItem value={MOTOKO_ROOT_ROUTE_SELECT_VALUE}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground/75" />
                          <span className="min-w-0 truncate font-mono text-[11px]">
                            {MOTOKO_ROOT_ROUTE_LABEL}
                          </span>
                        </span>
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.project.id} value={project.project.rootPath}>
                          <span className="grid min-w-0 gap-0.5">
                            <span className="truncate text-sm text-foreground">
                              {project.project.title}
                            </span>
                            <span className="truncate font-mono text-[11px] text-muted-foreground">
                              {project.project.rootPath}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectPopup>
                </Select>
              </div>

              <MotokoModelBadge status={status} />
              <MotokoFooterModeControls
                interactionMode={interactionMode}
                onToggleInteractionMode={onToggleInteractionMode}
              />
            </div>
            <div
              data-chat-composer-actions="right"
              className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
            >
              <MotokoContextWindowChip status={status} />
              <ComposerVoiceButton
                size="icon"
                className="size-9 rounded-full before:rounded-full sm:size-8"
                state={voiceTranscription.state}
                missingApiKey={voiceTranscription.missingApiKey}
                onStart={() => void voiceTranscription.start()}
                onStop={voiceTranscription.stop}
              />
              <Button
                type="submit"
                size="icon"
                className="size-9 rounded-full before:rounded-full sm:size-8"
                disabled={!canSend}
                aria-label="Send message to Motoko"
              >
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function MotokoCapsuleAvatar({
  available,
  pendingCount,
}: {
  available: boolean;
  pendingCount: number;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/70 bg-black p-2 shadow-[0_18px_44px_rgba(0,0,0,0.34)]">
      <div className="relative aspect-square overflow-hidden rounded-sm bg-black">
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 size-full select-none object-cover"
          draggable={false}
          src={MOTOKO_CAPSULE_FRAME_SRC}
        />
        <div
          className="absolute z-20 overflow-hidden bg-black shadow-[0_0_28px_rgba(236,72,153,0.2)]"
          style={MOTOKO_CAPSULE_VIDEO_WINDOW_STYLE}
        >
          <video
            aria-hidden="true"
            autoPlay={
              typeof window === "undefined" ||
              !window.matchMedia("(prefers-reduced-motion: reduce)").matches
            }
            className="size-full object-cover"
            loop
            muted
            playsInline
            preload="metadata"
            src={MOTOKO_CAPSULE_VIDEO_SRC}
          />
          <div className="pointer-events-none absolute inset-0 border border-fuchsia-300/20 shadow-[inset_0_0_30px_rgba(236,72,153,0.18)]" />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <div className="truncate font-medium text-fuchsia-100/90">Cyberbrain pod</div>
          <div className="truncate text-muted-foreground">{formatCount(pendingCount)} pending</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill label="Motoko" tone={available ? "success" : "warning"} />
          <StatusPill
            label={available ? "online" : "setup"}
            tone={available ? "success" : "warning"}
          />
        </div>
      </div>
    </div>
  );
}

function MotokoThinkingRow() {
  return (
    <div className="flex w-full justify-start">
      <div className="grid gap-1 rounded-2xl rounded-bl-md border border-border/70 bg-card/88 px-4 py-3 text-xs shadow-xs">
        <span className="font-medium text-foreground">Motoko</span>
        <span className="inline-flex items-center gap-2 text-muted-foreground">
          <Spinner className="size-3.5" />
          <span>
            Motoko is thinking
            <span aria-hidden="true" className="inline-flex">
              <span className="animate-bounce [animation-delay:-0.3s]">.</span>
              <span className="animate-bounce [animation-delay:-0.15s]">.</span>
              <span className="animate-bounce">.</span>
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

export function MotokoPanel({
  status,
  capacity,
  sessions,
  projects,
  log,
  proposals,
  loading,
  error,
  actionError,
  chatResult,
  commandResult,
  draft,
  scheduleResult,
  transcript,
  selectedProjectRoot,
  chatInput,
  interactionMode,
  scheduleKind,
  actionPending,
  onRefresh,
  onToggleInteractionMode,
  onProjectRootChange,
  onChatInputChange,
  onScheduleKindChange,
  onCheck,
  onSetupCodexOAuth,
  onStartAcp,
  onInspectGits,
  onChatSubmit,
  onClearChat,
  onNewChat,
  onDecision,
  onWriteContext,
  onDraft,
  onRunSchedule,
}: {
  status: HermesStatusResult | undefined;
  capacity: GitsCapacitySnapshot | undefined;
  sessions: HermesSessionListResult | undefined;
  projects: ReadonlyArray<GitsCockpitProject>;
  log: HermesLogTailResult | undefined;
  proposals: HermesProposalListResult | undefined;
  loading: boolean;
  error: unknown;
  actionError: unknown;
  chatResult: HermesChatResult | undefined;
  commandResult: HermesCommandResult | undefined;
  draft: HermesExecutionDraft | undefined;
  scheduleResult: HermesScheduleRunResult | undefined;
  transcript: ReadonlyArray<MotokoTranscriptEntry>;
  selectedProjectRoot: string;
  chatInput: string;
  interactionMode: MotokoInteractionMode;
  scheduleKind: HermesScheduleKind;
  actionPending: boolean;
  onRefresh: () => void;
  onToggleInteractionMode: () => void;
  onProjectRootChange: (value: string) => void;
  onChatInputChange: (value: string) => void;
  onScheduleKindChange: (value: HermesScheduleKind) => void;
  onCheck: () => void;
  onSetupCodexOAuth: () => void;
  onStartAcp: () => void;
  onInspectGits: () => void;
  onChatSubmit: () => void;
  onClearChat: () => void;
  onNewChat: () => void;
  onDecision: (proposal: HermesProposalCard, decision: MotokoProposalDecision) => void;
  onWriteContext: () => void;
  onDraft: (proposalId: string) => void;
  onRunSchedule: () => void;
}) {
  const cards = proposals?.proposals ?? [];
  const [proposalsOpen, setProposalsOpen] = useState(false);

  // --- Composer: panel-local input so submit can clear it immediately (optimistic),
  // instead of waiting for the shell's mutation onSuccess to clear `chatInput`. We still
  // push every change up via onChatInputChange to keep the shell's mirror in sync; the
  // ref lets us tell "the shell reset chatInput out from under us" (onNewChat) apart from
  // "we just pushed this value ourselves" so we don't fight our own optimistic clear.
  const [localChatInput, setLocalChatInput] = useState(chatInput);
  const pushedChatInputRef = useRef(chatInput);
  useEffect(() => {
    if (chatInput !== pushedChatInputRef.current) {
      pushedChatInputRef.current = chatInput;
      setLocalChatInput(chatInput);
    }
  }, [chatInput]);
  const setChatInput = (value: string) => {
    pushedChatInputRef.current = value;
    setLocalChatInput(value);
    onChatInputChange(value);
  };
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // --- Pending indicator + restore-on-error. `inFlightMessage` is the text of the send
  // this panel most recently kicked off; it's non-null exactly while we're waiting on
  // that specific chat call to settle (Send is disabled meanwhile, so at most one is ever
  // in flight). When actionPending drops, computeRestorableAfterSend checks whether the
  // transcript entry that call produced looks like a failure (no `result`) and, if so,
  // offers "Restore message" on it.
  const [inFlightMessage, setInFlightMessage] = useState<string | null>(null);
  const [restorable, setRestorable] = useState<{ entryId: string; message: string } | null>(null);
  const prevActionPendingRef = useRef(actionPending);
  useEffect(() => {
    const wasPending = prevActionPendingRef.current;
    prevActionPendingRef.current = actionPending;
    if (!wasPending || actionPending) {
      return;
    }
    const sent = inFlightMessage;
    setInFlightMessage(null);
    const next = computeRestorableAfterSend({ transcript, inFlightMessage: sent });
    if (next) {
      setRestorable(next);
    }
  }, [actionPending, transcript, inFlightMessage]);
  useEffect(() => {
    if (restorable && !transcript.some((entry) => entry.id === restorable.entryId)) {
      setRestorable(null);
    }
  }, [restorable, transcript]);

  const handleChatSubmit = () => {
    const message = localChatInput.trim();
    if (actionPending || message.length === 0) {
      return;
    }
    setInFlightMessage(message);
    setRestorable(null);
    setChatInput("");
    onChatSubmit();
  };

  const handleRestore = (message: string) => {
    setChatInput(message);
    setRestorable(null);
    textareaRef.current?.focus();
  };

  // --- Transcript auto-scroll: only follow new entries if the operator was already near
  // the bottom, so manual scrollback isn't fought.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const { visible: visibleTranscript, hiddenCount } = visibleTranscriptWindow(transcript);
  useEffect(() => {
    const node = transcriptRef.current;
    if (node && nearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [transcript.length, inFlightMessage]);

  const errorMessage =
    error instanceof Error
      ? error.message
      : actionError instanceof Error
        ? actionError.message
        : null;
  const pendingCount = cards.filter((proposal) => proposal.status === "proposed").length;
  const railProposals = cards
    .filter((proposal) => proposal.status === "proposed")
    .slice(0, MOTOKO_PROPOSAL_RAIL_LIMIT);
  const resultCount = [chatResult, commandResult, draft, scheduleResult].filter(Boolean).length;
  const routeLabel = motokoSelectedRouteLabel(selectedProjectRoot);
  const modelLabel = status?.model.model ?? "unknown";
  const contextWindowLabel = formatTokenLimit(status?.model.contextWindowTokens);

  return (
    <section className="border-b border-border bg-background">
      <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold">Motoko</h2>
            <StatusPill
              label={status?.available ? "ready" : "setup"}
              tone={status?.available ? "success" : "warning"}
            />
            <StatusPill
              label={status?.acp.available ? "ACP" : "ACP check"}
              tone={status?.acp.available ? "success" : "warning"}
            />
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            Hermes operator for GITS | {status?.version ?? "version unknown"} |{" "}
            {status?.config.hermesHome ?? "~/.gits/hermes"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setProposalsOpen(true)}>
            <ListChecksIcon className="size-3.5" />
            Proposals
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px] tabular-nums",
                pendingCount > 0
                  ? "bg-amber-500/15 text-amber-600"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {formatCount(pendingCount)}
            </span>
          </Button>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {errorMessage ? (
        <div
          aria-live="polite"
          className="border-b border-border/60 px-4 py-2 text-xs text-destructive sm:px-5"
        >
          {errorMessage}
        </div>
      ) : null}

      {status?.setupWarnings.length ? (
        <div className="divide-y divide-border/60 border-b border-border/60">
          {status.setupWarnings.slice(0, 5).map((warning, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- warnings can repeat; index keeps keys unique
            <div key={`warning-${index}`} className="px-4 py-2 text-xs text-amber-600 sm:px-5">
              {warning}
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 border-b border-border/60 lg:border-b-0 lg:border-r">
          <div className="flex min-h-[46rem] flex-col bg-background lg:min-h-[52rem]">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2 sm:px-5">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="font-medium text-muted-foreground">
                  Conversation ({formatCount(transcript.length)})
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">
                  {routeLabel}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onClearChat}
                  disabled={transcript.length === 0}
                >
                  <Trash2Icon className="size-3.5" />
                  Clear
                </Button>
                <Button size="sm" variant="outline" onClick={onNewChat}>
                  <MessageSquarePlusIcon className="size-3.5" />
                  New chat
                </Button>
              </div>
            </div>
            <div
              ref={transcriptRef}
              aria-live="polite"
              onScroll={(event) => {
                nearBottomRef.current = isNearBottom(event.currentTarget);
              }}
              className="flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_0%,--theme(--color-muted/32%),transparent_36%)] px-4 py-5 text-xs sm:px-5 sm:py-6"
            >
              {transcript.length === 0 && inFlightMessage === null ? (
                <div className="flex min-h-96 items-center justify-center">
                  <div className="grid justify-items-center gap-3 text-center">
                    <div className="overflow-hidden rounded-xl border border-border/70 bg-white p-2 shadow-[0_18px_44px_rgba(0,0,0,0.18)]">
                      <img
                        alt=""
                        aria-hidden="true"
                        className="size-24 rounded-lg object-cover"
                        draggable={false}
                        src={MOTOKO_CHAT_LOGO_SRC}
                      />
                    </div>
                    <EmptyState label="Motoko is standing by." />
                    <div className="max-w-80 px-4 text-xs text-muted-foreground">
                      Route {routeLabel} | Hermes {status?.model.provider ?? "provider unknown"} /{" "}
                      {modelLabel} | context {contextWindowLabel}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
                  {hiddenCount > 0 ? (
                    <div className="text-center text-[11px] text-muted-foreground">
                      +{formatCount(hiddenCount)} earlier messages hidden
                    </div>
                  ) : null}
                  {visibleTranscript.map((entry) => {
                    // Prefer the live proposal so inline decision buttons track current status.
                    const entryProposal = entry.result?.proposal
                      ? (cards.find((card) => card.id === entry.result?.proposal?.id) ??
                        entry.result.proposal)
                      : null;
                    const entryRestorable =
                      restorable?.entryId === entry.id ? restorable.message : null;
                    return (
                      <div
                        key={entry.id}
                        className={cn(
                          "flex w-full",
                          entry.role === "operator" ? "justify-end" : "justify-start",
                        )}
                      >
                        <div
                          className={cn(
                            "grid max-w-[92%] gap-2 rounded-2xl border px-4 py-3 shadow-xs",
                            entry.role === "operator"
                              ? "rounded-br-md border-primary/30 bg-primary text-primary-foreground"
                              : "rounded-bl-md border-border/70 bg-card/88 text-foreground",
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2">
                            <span
                              className={cn(
                                "font-medium",
                                entry.role === "operator"
                                  ? "text-primary-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {entry.role === "operator" ? "You" : "Motoko"}
                            </span>
                            <span
                              className={cn(
                                "text-[11px]",
                                entry.role === "operator"
                                  ? "text-primary-foreground/70"
                                  : "text-muted-foreground",
                              )}
                            >
                              {formatIsoDate(entry.createdAt)}
                            </span>
                          </div>
                          <pre
                            className={cn(
                              "whitespace-pre-wrap font-sans text-[13px] leading-relaxed",
                              entry.role === "operator"
                                ? "text-primary-foreground/95"
                                : "text-foreground",
                            )}
                          >
                            {entry.message}
                          </pre>
                          {entry.result?.status === "setup-required" ? (
                            <div className="grid gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                              <div className="font-medium text-amber-700">
                                {entry.result.setupTitle ?? "Hermes setup required"}
                              </div>
                              {entry.result.setupDetail ? (
                                <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-amber-700">
                                  {entry.result.setupDetail}
                                </pre>
                              ) : null}
                              {entry.result.setupCommand ? (
                                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2 py-2">
                                  <code className="min-w-0 flex-1 overflow-auto text-[11px] text-foreground">
                                    {entry.result.setupCommand}
                                  </code>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void navigator.clipboard.writeText(
                                        entry.result!.setupCommand!,
                                      )
                                    }
                                  >
                                    <CopyIcon className="size-3.5" />
                                    Copy
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {entryProposal ? (
                            <MotokoProposalCard
                              proposal={entryProposal}
                              actionPending={actionPending}
                              onDecision={onDecision}
                              onDraft={onDraft}
                            />
                          ) : null}
                          {entry.result?.blockedReason &&
                          entry.result.status !== "setup-required" ? (
                            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                              {entry.result.blockedReason}
                            </div>
                          ) : null}
                          {entryRestorable ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="justify-self-start"
                              onClick={() => handleRestore(entryRestorable)}
                            >
                              <RotateCcwIcon className="size-3.5" />
                              Restore message
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {inFlightMessage !== null ? <MotokoThinkingRow /> : null}
                </div>
              )}
            </div>

            <div className="border-t border-border/60 bg-background/96 px-4 py-4 backdrop-blur sm:px-5">
              <MotokoChatComposer
                status={status}
                projects={projects}
                selectedProjectRoot={selectedProjectRoot}
                value={localChatInput}
                interactionMode={interactionMode}
                actionPending={actionPending}
                onToggleInteractionMode={onToggleInteractionMode}
                onProjectRootChange={onProjectRootChange}
                onValueChange={setChatInput}
                onSubmit={handleChatSubmit}
                textareaRef={textareaRef}
              />
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="grid gap-4 px-4 py-4 text-xs sm:px-5">
            <MotokoCapsuleAvatar
              available={status?.available === true}
              pendingCount={pendingCount}
            />

            <div className="grid grid-cols-2 overflow-hidden rounded-md border border-border/70 bg-muted/20">
              <StatBlock label="Proposals" value={formatCount(cards.length)} icon={SparklesIcon} />
              <StatBlock
                label="Pending"
                value={formatCount(pendingCount)}
                icon={AlertTriangleIcon}
              />
              <StatBlock
                label="OAuth"
                value={status?.codexAuth.state ?? "unknown"}
                icon={ShieldCheckIcon}
              />
              <StatBlock
                label="Mode"
                value={status?.config.approvalMode ?? "unknown"}
                icon={PowerIcon}
              />
              <StatBlock
                label="Router"
                value={capacity?.recommendation.recommendedEngine ?? "check"}
                icon={BotIcon}
              />
              <StatBlock label="Model" value={modelLabel} icon={SparklesIcon} />
              <StatBlock label="Context" value={contextWindowLabel} icon={GaugeIcon} />
              <StatBlock
                label="Sessions"
                value={formatCount(sessions?.sessions.length ?? 0)}
                icon={BotIcon}
              />
            </div>

            {pendingCount > 0 ? (
              <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-muted-foreground">
                    Proposals awaiting decision
                  </div>
                  <StatusPill label={formatCount(pendingCount)} tone="warning" />
                </div>
                <div className="grid gap-2">
                  {railProposals.map((proposal) => (
                    <MotokoProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      actionPending={actionPending}
                      onDecision={onDecision}
                      onDraft={onDraft}
                      compact
                    />
                  ))}
                </div>
                {pendingCount > railProposals.length ? (
                  <Button size="sm" variant="ghost" onClick={() => setProposalsOpen(true)}>
                    See all {formatCount(pendingCount)} pending
                  </Button>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-muted-foreground">Motoko actions</div>
                <StatusPill
                  label={status?.available ? "ready" : "setup"}
                  tone={status?.available ? "success" : "warning"}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={onCheck} disabled={actionPending}>
                  <CheckCircle2Icon className="size-3.5" />
                  Check
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onSetupCodexOAuth}
                  disabled={actionPending}
                >
                  <ShieldCheckIcon className="size-3.5" />
                  Setup OAuth
                </Button>
                <Button size="sm" variant="outline" onClick={onStartAcp} disabled={actionPending}>
                  <BotIcon className="size-3.5" />
                  Start ACP
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onWriteContext}
                  disabled={actionPending || selectedProjectRoot.trim().length === 0}
                >
                  <FilePlus2Icon className="size-3.5" />
                  Write Context
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onInspectGits}
                  disabled={actionPending || selectedProjectRoot.trim().length === 0}
                >
                  <SearchIcon className="size-3.5" />
                  Inspect
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <select
                  value={scheduleKind}
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-3 text-xs"
                  onChange={(event) =>
                    onScheduleKindChange(event.currentTarget.value as HermesScheduleKind)
                  }
                >
                  {MOTOKO_SCHEDULE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRunSchedule}
                  disabled={actionPending}
                >
                  <PlayIcon className="size-3.5" />
                  Run
                </Button>
              </div>
            </div>

            {chatResult || commandResult || draft || scheduleResult ? (
              <div className="grid gap-3">
                <SectionHeader title="Result" count={resultCount} />
                {chatResult ? (
                  <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusPill
                        label={chatResult.status}
                        tone={
                          chatResult.status === "blocked"
                            ? "danger"
                            : chatResult.status === "setup-required"
                              ? "warning"
                              : "success"
                        }
                      />
                      <StatusPill label={chatResult.actionKind} tone="default" />
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-foreground">
                      {chatResult.response}
                    </pre>
                  </div>
                ) : null}
                {commandResult ? (
                  <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusPill
                        label={commandResult.status}
                        tone={hermesCommandResultTone(commandResult.status)}
                      />
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {commandResult.action} | {formatCount(commandResult.durationMs)} ms
                      </span>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                      {[commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n") ||
                        "No command output."}
                    </pre>
                  </div>
                ) : null}
                {draft ? (
                  <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusPill
                        label={draft.status}
                        tone={draft.status === "draft" ? "success" : "danger"}
                      />
                      <StatusPill label={draft.kind} tone="default" />
                    </div>
                    <div className="truncate font-medium">{draft.title}</div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                      {draft.prompt}
                    </pre>
                  </div>
                ) : null}
                {scheduleResult ? (
                  <div className="grid gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <StatusPill
                        label={scheduleResult.blockedReason ? "blocked" : scheduleResult.kind}
                        tone={scheduleResult.blockedReason ? "danger" : "success"}
                      />
                      <span className="text-muted-foreground">
                        {formatIsoDate(scheduleResult.ranAt)}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      {scheduleResult.blockedReason ??
                        `${formatCount(scheduleResult.proposals.length)} proposal cards generated.`}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
              <div className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">
                Log
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {log?.text ?? "No Hermes log output."}
              </pre>
            </div>

            <div className="overflow-hidden rounded-md border border-border/70 bg-muted/20">
              <div className="border-b border-border/60 px-3 py-2 font-medium text-muted-foreground">
                Sessions
              </div>
              {(sessions?.sessions.length ?? 0) === 0 ? (
                <EmptyState label="No Hermes sessions found." />
              ) : (
                <div className="divide-y divide-border/60">
                  {sessions?.sessions.map((session) => (
                    <div key={session.id} className="px-3 py-2">
                      <div className="truncate font-mono text-[11px] text-foreground">
                        {session.id}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                        {session.title ?? session.summary ?? session.status}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <Sheet open={proposalsOpen} onOpenChange={setProposalsOpen}>
        <SheetPopup side="right" className="max-w-xl">
          <SheetHeader>
            <SheetTitle>Motoko proposals</SheetTitle>
            <SheetDescription>
              {formatCount(pendingCount)} pending | {formatCount(cards.length)} total
            </SheetDescription>
          </SheetHeader>
          <SheetPanel className="grid gap-3">
            {loading && cards.length === 0 ? (
              <EmptyState label="Loading Motoko proposals..." />
            ) : cards.length === 0 ? (
              <EmptyState label="No Motoko proposals." />
            ) : (
              cards.map((proposal) => (
                <MotokoProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  actionPending={actionPending}
                  onDecision={onDecision}
                  onDraft={onDraft}
                />
              ))
            )}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </section>
  );
}

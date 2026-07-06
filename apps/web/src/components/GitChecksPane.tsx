import type { ChangeRequestCheckState, VcsStatusResult } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageSquareWarningIcon,
  XCircleIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentation } from "~/sourceControlPresentation";

type CheckTone = "ok" | "warning" | "blocked" | "neutral";

interface CheckRow {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: CheckTone;
}

interface GitChecksPaneProps {
  readonly gitStatus: VcsStatusResult | null;
}

function rowToneClass(tone: CheckTone): string {
  if (tone === "ok") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "blocked") return "text-destructive";
  return "text-muted-foreground";
}

function rowIcon(tone: CheckTone) {
  const className = cn("mt-0.5 size-3.5 shrink-0", rowToneClass(tone));
  if (tone === "ok") return <CheckCircle2Icon aria-hidden="true" className={className} />;
  if (tone === "blocked") return <XCircleIcon aria-hidden="true" className={className} />;
  if (tone === "warning") return <AlertCircleIcon aria-hidden="true" className={className} />;
  return <CircleDashedIcon aria-hidden="true" className={className} />;
}

function checkStateTone(state: ChangeRequestCheckState): CheckTone {
  if (state === "passed" || state === "skipped") return "ok";
  if (state === "failed") return "blocked";
  if (state === "pending") return "warning";
  return "neutral";
}

function formatCheckState(state: ChangeRequestCheckState): string {
  if (state === "passed") return "passed";
  if (state === "failed") return "failed";
  if (state === "pending") return "pending";
  if (state === "skipped") return "skipped";
  return "unknown";
}

function buildRows(gitStatus: VcsStatusResult | null): CheckRow[] {
  if (!gitStatus) {
    return [
      {
        id: "status",
        label: "Git status",
        detail: "Unavailable",
        tone: "warning",
      },
    ];
  }

  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;
  const checks = gitStatus.prChecks;
  const rows: CheckRow[] = [
    {
      id: "working-tree",
      label: "Working tree",
      detail: gitStatus.hasWorkingTreeChanges ? "Uncommitted changes" : "Clean",
      tone: gitStatus.hasWorkingTreeChanges ? "warning" : "ok",
    },
  ];

  if (gitStatus.refName === null) {
    rows.push({
      id: "branch",
      label: "Branch",
      detail: "Detached HEAD",
      tone: "warning",
    });
  } else if (gitStatus.aheadCount > 0 && gitStatus.behindCount > 0) {
    rows.push({
      id: "branch",
      label: "Branch",
      detail: `${gitStatus.aheadCount} ahead, ${gitStatus.behindCount} behind`,
      tone: "blocked",
    });
  } else if (gitStatus.behindCount > 0) {
    rows.push({
      id: "branch",
      label: "Branch",
      detail: `${gitStatus.behindCount} behind upstream`,
      tone: "warning",
    });
  } else if (gitStatus.aheadCount > 0) {
    rows.push({
      id: "branch",
      label: "Branch",
      detail: `${gitStatus.aheadCount} ahead of upstream`,
      tone: "warning",
    });
  } else if (!gitStatus.hasUpstream) {
    rows.push({
      id: "branch",
      label: "Branch",
      detail: "No upstream",
      tone: "warning",
    });
  } else {
    rows.push({
      id: "branch",
      label: "Branch",
      detail: "Up to date",
      tone: "ok",
    });
  }

  rows.push({
    id: "change-request",
    label: terminology.shortLabel,
    detail:
      gitStatus.pr === null
        ? `No ${terminology.singular}`
        : `#${gitStatus.pr.number} ${gitStatus.pr.state}`,
    tone: gitStatus.pr?.state === "open" ? "ok" : "warning",
  });

  if (gitStatus.pr === null) {
    rows.push({
      id: "checks",
      label: "Checks",
      detail: "No change request",
      tone: "neutral",
    });
    return rows;
  }

  if (checks === null || checks === undefined) {
    rows.push({
      id: "checks",
      label: "Checks",
      detail: "Unavailable",
      tone: "warning",
    });
    return rows;
  }

  rows.push({
    id: "checks",
    label: "Checks",
    detail:
      checks.checks.length === 0
        ? "No checks reported"
        : `${checks.summary.passed} passed, ${checks.summary.failed} failed, ${checks.summary.pending} pending`,
    tone: checks.summary.failed > 0 ? "blocked" : checks.summary.pending > 0 ? "warning" : "ok",
  });

  if (checks.mergeable) {
    rows.push({
      id: "mergeable",
      label: "Mergeability",
      detail: checks.mergeable,
      tone:
        checks.mergeable === "mergeable"
          ? "ok"
          : checks.mergeable === "conflicting"
            ? "blocked"
            : "warning",
    });
  }

  if (checks.unresolvedReviewThreads !== undefined) {
    rows.push({
      id: "review-threads",
      label: "Review threads",
      detail:
        checks.unresolvedReviewThreads === 0
          ? "Resolved"
          : `${checks.unresolvedReviewThreads} unresolved`,
      tone: checks.unresolvedReviewThreads === 0 ? "ok" : "blocked",
    });
  }

  return rows;
}

export function GitChecksPane({ gitStatus }: GitChecksPaneProps) {
  const rows = buildRows(gitStatus);
  const checks = gitStatus?.prChecks;
  const hasBlockers = rows.some((row) => row.tone === "blocked");

  return (
    <section
      aria-label="Checks"
      className={cn(
        "mx-1 my-1.5 min-w-72 rounded-md border bg-background p-2 text-xs",
        hasBlockers ? "border-destructive/35" : "border-border",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 font-medium">
          <GitPullRequestIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          Checks
        </div>
        {hasBlockers ? (
          <span className="text-[11px] text-destructive">Blockers flagged</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">No blockers</span>
        )}
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-2">
            {rowIcon(row.tone)}
            <span className="text-muted-foreground">{row.label}</span>
            <span
              className={cn("max-w-40 truncate text-right font-medium", rowToneClass(row.tone))}
            >
              {row.detail}
            </span>
          </div>
        ))}
      </div>
      {checks && checks.checks.length > 0 ? (
        <div className="mt-2 border-t border-border pt-2">
          <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
            <GitBranchIcon aria-hidden="true" className="size-3.5" />
            Check runs
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
            {checks.checks.map((check) => (
              <div
                key={`${check.name}-${check.state}`}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-2"
                title={check.name}
              >
                {rowIcon(checkStateTone(check.state))}
                <span className="truncate">{check.name}</span>
                <span className={cn("text-[11px]", rowToneClass(checkStateTone(check.state)))}>
                  {formatCheckState(check.state)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {checks?.unresolvedReviewThreads ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-destructive">
          <MessageSquareWarningIcon aria-hidden="true" className="size-3.5" />
          Review comments need attention
        </div>
      ) : null}
    </section>
  );
}

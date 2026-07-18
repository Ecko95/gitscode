import type { VcsStatusResult } from "@t3tools/contracts";

import { getSourceControlPresentation } from "~/sourceControlPresentation";

export type GitStatusTone = "ok" | "warning" | "blocked" | "neutral";

export interface GitStatusSummary {
  readonly tone: GitStatusTone;
  readonly branchLabel: string;
  readonly label: string;
}

export interface GitStatusPrActions {
  readonly createPr: { readonly label: string } | null;
  readonly openPr: { readonly label: string; readonly url: string } | null;
  readonly review: { readonly reference: string } | null;
}

export function summarizeGitStatus(gitStatus: VcsStatusResult | null): GitStatusSummary {
  if (!gitStatus || !gitStatus.isRepo) {
    return {
      tone: "neutral",
      branchLabel: "No repository",
      label: "Git status unavailable",
    };
  }

  const branchLabel = gitStatus.refName ?? "Detached HEAD";
  const isDiverged = gitStatus.aheadCount > 0 && gitStatus.behindCount > 0;
  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push("uncommitted changes");
  }
  if (isDiverged) {
    parts.push(`${gitStatus.aheadCount} ahead / ${gitStatus.behindCount} behind`);
  } else if (gitStatus.behindCount > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  } else if (gitStatus.aheadCount > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  } else if (!gitStatus.hasUpstream) {
    parts.push("not pushed");
  }
  if (gitStatus.pr) {
    const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;
    parts.push(`${terminology.shortLabel} #${gitStatus.pr.number} ${gitStatus.pr.state}`);
  }
  if (parts.length === 0) {
    parts.push("up to date");
  }

  const tone: GitStatusTone = isDiverged
    ? "blocked"
    : gitStatus.refName === null ||
        gitStatus.hasWorkingTreeChanges ||
        gitStatus.aheadCount > 0 ||
        gitStatus.behindCount > 0 ||
        !gitStatus.hasUpstream
      ? "warning"
      : "ok";

  return { tone, branchLabel, label: `${branchLabel} — ${parts.join(", ")}` };
}

export function resolvePrActions(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
): GitStatusPrActions {
  if (!gitStatus || !gitStatus.isRepo) {
    return { createPr: null, openPr: null, review: null };
  }

  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;
  const pr = gitStatus.pr;
  const hasOpenPr = pr?.state === "open";
  const openPr =
    pr && pr.url.trim().length > 0
      ? { label: `View ${terminology.shortLabel} #${pr.number}`, url: pr.url }
      : null;
  const review = hasOpenPr && openPr !== null ? { reference: openPr.url } : null;

  const aheadOfDefault = gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount;
  const canCreatePr =
    !isBusy &&
    gitStatus.hasPrimaryRemote &&
    !gitStatus.isDefaultRef &&
    gitStatus.refName !== null &&
    !gitStatus.hasWorkingTreeChanges &&
    !hasOpenPr &&
    aheadOfDefault > 0 &&
    gitStatus.behindCount === 0;

  return {
    createPr: canCreatePr ? { label: `Create ${terminology.shortLabel}` } : null,
    openPr,
    review,
  };
}

import type { CockpitInboxFilter, CockpitInboxItem, CockpitInboxState } from "@t3tools/contracts";

export const INBOX_FILTERS: ReadonlyArray<{
  readonly value: CockpitInboxFilter;
  readonly label: string;
}> = [
  { value: "unread", label: "Unread" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "waiting", label: "Waiting" },
  { value: "completed", label: "Completed" },
];

const STATE_LABELS: Record<CockpitInboxState, string> = {
  "pending-review": "Pending review",
  "approved-queued": "Approved · queued",
  "waiting-quota-reset": "Waiting for capacity",
  "scheduled-tonight": "Scheduled tonight",
  running: "Running",
  "attention-required": "Attention required",
  completed: "Completed",
  rejected: "Rejected",
  deferred: "Deferred",
};

export function inboxStateLabel(state: CockpitInboxState): string {
  return STATE_LABELS[state];
}

export function inboxStateTone(
  state: CockpitInboxState,
): "default" | "success" | "warning" | "danger" {
  if (state === "running" || state === "completed") return "success";
  if (state === "attention-required" || state === "rejected") return "danger";
  if (["pending-review", "waiting-quota-reset", "scheduled-tonight"].includes(state)) {
    return "warning";
  }
  return "default";
}

export function isInboxItemUnread(item: CockpitInboxItem): boolean {
  return item.readAt === null || item.readAt < item.updatedAt;
}

export function orderedInboxTimeline(item: CockpitInboxItem) {
  return item.timeline.toSorted((left, right) => right.at.localeCompare(left.at));
}

export function inboxItemDeepLink(item: CockpitInboxItem): string {
  return item.deepLink;
}

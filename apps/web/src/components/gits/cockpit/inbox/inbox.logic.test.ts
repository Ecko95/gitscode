import { describe, expect, it } from "vitest";

import type { CockpitInboxItem } from "@t3tools/contracts";

import {
  INBOX_FILTERS,
  inboxItemDeepLink,
  inboxStateLabel,
  inboxStateTone,
  isInboxItemUnread,
  orderedInboxTimeline,
} from "./inbox.logic";

const item: CockpitInboxItem = {
  id: "epi-1",
  proposalId: "proposal-1",
  goalId: null,
  title: "Bound retries",
  repository: "/tmp/repo",
  state: "pending-review",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  terminalAt: null,
  readAt: null,
  pinned: false,
  reason: "Ready",
  deepLink: "/stale",
  timeline: [
    {
      eventKey: "older",
      at: "2026-01-01T00:00:00.000Z",
      state: "pending-review",
      reason: "Ready",
      deepLink: "/stale",
    },
    {
      eventKey: "newer",
      at: "2026-01-02T00:00:00.000Z",
      state: "approved-queued",
      reason: "Queued",
      deepLink: "/stale",
    },
  ],
};

describe("Cockpit Inbox logic", () => {
  it("keeps the requested filters in operator order", () => {
    expect(INBOX_FILTERS.map((filter) => filter.label)).toEqual([
      "Unread",
      "Pending",
      "Approved",
      "Waiting",
      "Completed",
    ]);
  });

  it("maps states and orders newest events first", () => {
    expect(inboxStateLabel("waiting-quota-reset")).toBe("Waiting for capacity");
    expect(inboxStateTone("attention-required")).toBe("danger");
    expect(orderedInboxTimeline(item).map((event) => event.eventKey)).toEqual(["newer", "older"]);
  });

  it("derives unread and chooses proposal or goal deep links", () => {
    expect(isInboxItemUnread(item)).toBe(true);
    expect(inboxItemDeepLink(item)).toContain("proposal=proposal-1");
    expect(inboxItemDeepLink({ ...item, goalId: "goal-1" })).toContain("goal=goal-1");
  });
});

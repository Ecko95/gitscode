import { describe, expect, it } from "vitest";

import { countGoalsCompletedToday, groupEpisodesByLondonDay, londonDayKey } from "./overview.logic";

describe("londonDayKey", () => {
  it("rolls a late UTC evening into the next London day during BST", () => {
    expect(londonDayKey("2026-07-15T23:30:00.000Z")).toBe("2026-07-16");
  });

  it("stays on the same London day during GMT (no DST offset)", () => {
    expect(londonDayKey("2026-01-15T23:30:00.000Z")).toBe("2026-01-15");
  });
});

describe("groupEpisodesByLondonDay", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("zero-fills the requested window and drops episodes outside it", () => {
    const buckets = groupEpisodesByLondonDay(
      [
        // outside the 3-day window (2026-07-18..20) — must be dropped, not miscounted.
        { verdict: "pass", flagged: false, createdAt: "2026-07-17T10:00:00.000Z" },
      ],
      3,
      now,
    );
    expect(buckets.map((b) => b.dayKey)).toEqual(["2026-07-18", "2026-07-19", "2026-07-20"]);
    expect(buckets.every((b) => b.landed === 0 && b.flagged === 0 && b.failed === 0)).toBe(true);
    expect(buckets[0]!.label).toBe("07/18");
  });

  it("splits landed/flagged/failed per episode, with fail winning over flagged", () => {
    const buckets = groupEpisodesByLondonDay(
      [
        { verdict: "fail", flagged: true, createdAt: "2026-07-18T09:00:00.000Z" },
        { verdict: "pass", flagged: true, createdAt: "2026-07-19T09:00:00.000Z" },
        { verdict: "pass", flagged: false, createdAt: "2026-07-19T15:00:00.000Z" },
      ],
      3,
      now,
    );
    const [day18, day19, day20] = buckets;
    expect(day18).toMatchObject({ landed: 0, flagged: 0, failed: 1 });
    expect(day19).toMatchObject({ landed: 1, flagged: 1, failed: 0 });
    expect(day20).toMatchObject({ landed: 0, flagged: 0, failed: 0 });
  });
});

describe("countGoalsCompletedToday", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("counts only completed goals updated on today's London day", () => {
    const count = countGoalsCompletedToday(
      [
        { status: "completed", updatedAt: "2026-07-20T08:00:00.000Z" },
        { status: "completed", updatedAt: "2026-07-19T08:00:00.000Z" },
        { status: "running", updatedAt: "2026-07-20T09:00:00.000Z" },
      ],
      now,
    );
    expect(count).toBe(1);
  });
});

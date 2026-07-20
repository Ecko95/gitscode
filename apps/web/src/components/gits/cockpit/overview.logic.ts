/** Pure Overview-dashboard logic: episode day-bucketing (London calendar days) and
 *  today's-completed-goal filtering. No DOM, no React, no network. */

import type { AutomodeEpisode, AutomodeGoal } from "@t3tools/contracts";

const LONDON_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" London calendar day for an ISO timestamp (DST-aware). */
export function londonDayKey(iso: string): string {
  return LONDON_DAY_FORMAT.format(new Date(iso));
}

export interface EpisodeNightTally {
  readonly dayKey: string;
  /** Compact "MM/DD" bar-chart axis label. */
  readonly label: string;
  readonly landed: number;
  readonly flagged: number;
  readonly failed: number;
}

const ONE_DAY_MS = 86_400_000;

/**
 * Buckets episodes into the last `days` London calendar days (oldest -> newest,
 * zero-filled so the bar chart always shows a full window). Three-way split per
 * episode: a "fail" verdict always counts as failed even if also flagged; otherwise
 * the review's `flagged` hold-for-review flag counts as flagged; everything else
 * landed (auto-merged).
 *
 * ponytail: day boundaries are `now - i*24h` run through the London-timezone
 * formatter, not calendar-incremented — on the two DST-transition days a year this
 * can double up or skip a bucket by up to an hour. Upgrade to per-day Intl part
 * construction if that ever visibly matters for a 14-day chart.
 */
export function groupEpisodesByLondonDay(
  episodes: ReadonlyArray<Pick<AutomodeEpisode, "verdict" | "flagged" | "createdAt">>,
  days = 14,
  now: Date = new Date(),
): EpisodeNightTally[] {
  const buckets = new Map<string, { landed: number; flagged: number; failed: number }>();
  const order: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayKey = londonDayKey(new Date(now.getTime() - i * ONE_DAY_MS).toISOString());
    if (!buckets.has(dayKey)) {
      buckets.set(dayKey, { landed: 0, flagged: 0, failed: 0 });
      order.push(dayKey);
    }
  }
  for (const episode of episodes) {
    const bucket = buckets.get(londonDayKey(episode.createdAt));
    if (!bucket) continue; // outside the window
    if (episode.verdict === "fail") bucket.failed += 1;
    else if (episode.flagged) bucket.flagged += 1;
    else bucket.landed += 1;
  }
  return order.map((dayKey) => ({
    dayKey,
    label: dayKey.slice(5).replace("-", "/"),
    ...buckets.get(dayKey)!,
  }));
}

/** Goals with status "completed" whose `updatedAt` falls on today's London calendar day. */
export function countGoalsCompletedToday(
  goals: ReadonlyArray<Pick<AutomodeGoal, "status" | "updatedAt">>,
  now: Date = new Date(),
): number {
  const today = londonDayKey(now.toISOString());
  return goals.filter(
    (goal) => goal.status === "completed" && londonDayKey(goal.updatedAt) === today,
  ).length;
}

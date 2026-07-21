import * as Effect from "effect/Effect";

import type { AutomodeGoal } from "@t3tools/contracts";

import { AutomodeSupervisor } from "./Services/AutomodeSupervisor.ts";
import { GitsSlotScheduler } from "./Services/GitsSlotScheduler.ts";

// Short, phone-typable goal reference shown in Telegram messages: the first 4 hex
// chars of the goal's uuid. Codes derive from the id (never a list position), so a
// code can't silently start pointing at a different goal as the queue shifts.
export function shortGoalCode(goalId: string): string {
  return goalId.replace(/^goal-/, "").slice(0, 4);
}

const LIVE_GOAL_STATUSES = new Set(["queued", "waiting-approval", "blocked", "running"]);

export type GoalTokenResolution =
  | { readonly kind: "ok"; readonly goalId: string }
  | { readonly kind: "ambiguous"; readonly matches: ReadonlyArray<AutomodeGoal> }
  | { readonly kind: "not-found" };

// Resolve a Telegram goal token: exact id always wins; otherwise a case-insensitive
// prefix (with or without the "goal-" prefix, >= 3 chars) must match exactly one
// LIVE goal — ambiguity is reported, never guessed.
export function resolveGoalToken(
  goals: ReadonlyArray<AutomodeGoal>,
  token: string,
): GoalTokenResolution {
  const exact = goals.find((goal) => goal.id === token);
  if (exact !== undefined) return { kind: "ok", goalId: exact.id };
  const needle = token.toLowerCase().replace(/^goal-/, "");
  if (needle.length < 3) return { kind: "not-found" };
  const matches = goals.filter(
    (goal) =>
      LIVE_GOAL_STATUSES.has(goal.status) &&
      goal.id
        .replace(/^goal-/, "")
        .toLowerCase()
        .startsWith(needle),
  );
  if (matches.length === 1) return { kind: "ok", goalId: matches[0]!.id };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "not-found" };
}

export type HermesTelegramCommand =
  | { readonly _tag: "approve"; readonly goalId: string }
  | { readonly _tag: "reject"; readonly goalId: string }
  | { readonly _tag: "defer"; readonly goalId: string }
  | { readonly _tag: "arm" }
  | { readonly _tag: "skip"; readonly goalId: string }
  | { readonly _tag: "stop" }
  | { readonly _tag: "invalid" };

const HELP =
  "Commands: APPROVE <code>, REJECT <code>, DEFER <code>, ARM, SKIP <code>, STOP. <code> is the short code from the goal message (e.g. 68a5) or a full goal id.";

export function parseHermesTelegramCommand(text: string): HermesTelegramCommand {
  const [verb, goalId, extra] = text.trim().split(/\s+/);
  const normalizedVerb = verb?.toUpperCase();

  if (extra !== undefined) return { _tag: "invalid" };
  if (normalizedVerb === "ARM" && goalId === undefined) return { _tag: "arm" };
  if (normalizedVerb === "STOP" && goalId === undefined) return { _tag: "stop" };
  if (goalId === undefined) return { _tag: "invalid" };

  switch (normalizedVerb) {
    case "APPROVE":
      return { _tag: "approve", goalId };
    case "REJECT":
      return { _tag: "reject", goalId };
    case "DEFER":
      return { _tag: "defer", goalId };
    case "SKIP":
      return { _tag: "skip", goalId };
    default:
      return { _tag: "invalid" };
  }
}

function describeResolutionFailure(resolution: GoalTokenResolution, token: string): string {
  if (resolution.kind === "ambiguous") {
    const options = resolution.matches
      .map((goal) => `${shortGoalCode(goal.id)} (${goal.title.slice(0, 40)})`)
      .join(", ");
    return `'${token}' matches several goals: ${options}. Add more characters.`;
  }
  return `No live goal matches '${token}'.`;
}

export function dispatchHermesTelegramCommand(command: HermesTelegramCommand) {
  return Effect.gen(function* () {
    // Resolve short codes once for every goal-targeting verb.
    let resolvedGoalId: string | null = null;
    if (
      command._tag === "approve" ||
      command._tag === "reject" ||
      command._tag === "defer" ||
      command._tag === "skip"
    ) {
      const supervisor = yield* AutomodeSupervisor;
      const snapshot = yield* supervisor.getSnapshot();
      const resolution = resolveGoalToken(snapshot.goals, command.goalId);
      if (resolution.kind !== "ok") {
        return describeResolutionFailure(resolution, command.goalId);
      }
      resolvedGoalId = resolution.goalId;
    }
    switch (command._tag) {
      case "approve": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.approveGoal({ goalId: resolvedGoalId ?? command.goalId });
        return "Goal approved.";
      }
      case "reject": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.rejectGoal({ goalId: resolvedGoalId ?? command.goalId });
        return "Goal rejected.";
      }
      case "defer": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.rejectGoal({
          goalId: resolvedGoalId ?? command.goalId,
          reason: "Deferred by operator.",
        });
        return "Goal deferred.";
      }
      case "arm": {
        const scheduler = yield* GitsSlotScheduler;
        yield* scheduler.arm();
        return "Scheduler armed.";
      }
      case "skip": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.rejectGoal({
          goalId: resolvedGoalId ?? command.goalId,
          reason: "Skipped by operator.",
        });
        return "Goal skipped.";
      }
      case "stop": {
        const supervisor = yield* AutomodeSupervisor;
        const { stoppedPeers, failures } = yield* supervisor.stopAll();
        return failures === 0
          ? `Stop requested for ${stoppedPeers} peer(s).`
          : `Stop requested for ${stoppedPeers} peer(s); ${failures} failed.`;
      }
      case "invalid":
        return HELP;
    }
  }).pipe(Effect.catchCause(() => Effect.succeed("Command failed.")));
}

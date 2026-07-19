import * as Effect from "effect/Effect";

import { AutomodeSupervisor } from "./Services/AutomodeSupervisor.ts";
import { DelamainAdapter } from "./Services/DelamainAdapter.ts";
import { GitsSlotScheduler } from "./Services/GitsSlotScheduler.ts";

export type HermesTelegramCommand =
  | { readonly _tag: "approve"; readonly goalId: string }
  | { readonly _tag: "reject"; readonly goalId: string }
  | { readonly _tag: "defer"; readonly goalId: string }
  | { readonly _tag: "arm" }
  | { readonly _tag: "skip"; readonly goalId: string }
  | { readonly _tag: "stop" }
  | { readonly _tag: "invalid" };

const HELP =
  "Commands: APPROVE <goal-id>, REJECT <goal-id>, DEFER <goal-id>, ARM, SKIP <goal-id>, STOP.";

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

export function dispatchHermesTelegramCommand(command: HermesTelegramCommand) {
  return Effect.gen(function* () {
    switch (command._tag) {
      case "approve": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.approveGoal({ goalId: command.goalId });
        return "Goal approved.";
      }
      case "reject": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.rejectGoal({ goalId: command.goalId });
        return "Goal rejected.";
      }
      case "defer": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.rejectGoal({ goalId: command.goalId, reason: "Deferred by operator." });
        return "Goal deferred.";
      }
      case "arm": {
        const scheduler = yield* GitsSlotScheduler;
        yield* scheduler.arm();
        return "Scheduler armed.";
      }
      case "skip": {
        const supervisor = yield* AutomodeSupervisor;
        yield* supervisor.rejectGoal({ goalId: command.goalId, reason: "Skipped by operator." });
        return "Goal skipped.";
      }
      case "stop": {
        const supervisor = yield* AutomodeSupervisor;
        const delamain = yield* DelamainAdapter;
        yield* supervisor.updatePolicy({ killSwitchEnabled: true });
        const snapshot = yield* supervisor.getSnapshot();
        let stopped = 0;
        let failed = 0;

        for (const goal of snapshot.goals) {
          const status: string = goal.status;
          if (goal.peerId === null || (status !== "running" && status !== "pending")) continue;
          // Workflow-dispatched goals track the run id as peerId — kill the whole run
          // (runner + live leaves), not the run record as a lone peer. Both branches are
          // mapped to a boolean so the differing success types don't form an Effect union.
          const ok = yield* (
            goal.workflowId
              ? delamain.workflowKill({ workflowId: goal.workflowId }).pipe(Effect.as(true))
              : delamain.killPeer({ peerId: goal.peerId }).pipe(Effect.as(true))
          ).pipe(Effect.orElseSucceed(() => false));
          if (ok) {
            stopped += 1;
          } else {
            failed += 1;
          }
        }

        return failed === 0
          ? `Stop requested for ${stopped} peer(s).`
          : `Stop requested for ${stopped} peer(s); ${failed} failed.`;
      }
      case "invalid":
        return HELP;
    }
  }).pipe(Effect.catchCause(() => Effect.succeed("Command failed.")));
}

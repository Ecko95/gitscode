import * as Effect from "effect/Effect";

import {
  AutomodeSupervisorError,
  type AutopilotConfigureInput,
  type AutopilotControlSnapshot,
  type AutomodeStopAllResult,
} from "@t3tools/contracts";

import type { AutomodeSupervisorShape } from "../Services/AutomodeSupervisor.ts";
import type { GitsSlotSchedulerShape } from "../Services/GitsSlotScheduler.ts";

const schedulerError = (message: string) => (cause: unknown) =>
  new AutomodeSupervisorError({ message, cause });

export function configureAutopilot(
  dependencies: {
    readonly supervisor: Pick<AutomodeSupervisorShape, "updatePolicy">;
    readonly scheduler: Pick<GitsSlotSchedulerShape, "setConfig" | "disarm">;
  },
  input: AutopilotConfigureInput,
): Effect.Effect<AutopilotControlSnapshot, AutomodeSupervisorError> {
  if (input.enabled && input.repositories.length === 0) {
    return Effect.fail(
      new AutomodeSupervisorError({ message: "Choose at least one repository for Autopilot." }),
    );
  }

  return Effect.gen(function* () {
    const scheduler = input.enabled
      ? yield* dependencies.scheduler
          .setConfig({ enabled: true })
          .pipe(Effect.mapError(schedulerError("Failed to enable the Autopilot scheduler.")))
      : yield* dependencies.scheduler
          .disarm({ reason: "Autopilot paused." })
          .pipe(Effect.mapError(schedulerError("Failed to pause the Autopilot scheduler.")));
    const automode = yield* dependencies.supervisor.updatePolicy(
      input.enabled
        ? {
            mode: "autonomous",
            killSwitchEnabled: false,
            maxActivePeers: 1,
            allowedRepos: input.repositories,
            proposalRepos: input.repositories,
            nightlyProposalSweep: true,
            sweepRequiresConfirmation: true,
            autoEnqueueApprovedProposals: true,
            gitsNotificationsEnabled: true,
          }
        : {
            mode: "manual",
            allowedRepos: input.repositories,
            proposalRepos: input.repositories,
            nightlyProposalSweep: false,
          },
    );
    return { automode, scheduler };
  });
}

export function emergencyStopAutopilot(dependencies: {
  readonly supervisor: Pick<AutomodeSupervisorShape, "stopAll">;
  readonly scheduler: Pick<GitsSlotSchedulerShape, "disarm">;
}): Effect.Effect<AutomodeStopAllResult, AutomodeSupervisorError> {
  return dependencies.scheduler
    .disarm({ reason: "Autopilot emergency stop." })
    .pipe(
      Effect.mapError(schedulerError("Failed to disarm the Autopilot scheduler.")),
      Effect.flatMap(() => dependencies.supervisor.stopAll()),
    );
}

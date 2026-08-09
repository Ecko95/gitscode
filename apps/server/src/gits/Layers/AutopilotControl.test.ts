import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  GitsSlotSchedulerError,
  type AutomodeSnapshot,
  type GitsSchedulerSnapshot,
} from "@t3tools/contracts";

import { configureAutopilot, emergencyStopAutopilot } from "./AutopilotControl.ts";

const automode = { policy: { mode: "manual" } } as AutomodeSnapshot;
const scheduler = { config: { enabled: false } } as GitsSchedulerSnapshot;

describe("AutopilotControl", () => {
  it("enables the scheduler before switching to the safe autonomous policy", async () => {
    const calls: Array<readonly [string, unknown]> = [];
    const result = await Effect.runPromise(
      configureAutopilot(
        {
          scheduler: {
            setConfig: (input) =>
              Effect.sync(() => {
                calls.push(["scheduler.setConfig", input]);
                return scheduler;
              }),
            disarm: () => Effect.succeed(scheduler),
          },
          supervisor: {
            updatePolicy: (input) =>
              Effect.sync(() => {
                calls.push(["supervisor.updatePolicy", input]);
                return automode;
              }),
          },
        },
        { enabled: true, repositories: ["/srv/repo"] },
      ),
    );

    expect(calls).toEqual([
      ["scheduler.setConfig", { enabled: true }],
      [
        "supervisor.updatePolicy",
        {
          mode: "autonomous",
          killSwitchEnabled: false,
          maxActivePeers: 1,
          allowedRepos: ["/srv/repo"],
          proposalRepos: ["/srv/repo"],
          nightlyProposalSweep: true,
          sweepRequiresConfirmation: true,
          autoEnqueueApprovedProposals: true,
          gitsNotificationsEnabled: true,
        },
      ],
    ]);
    expect(result).toEqual({ automode, scheduler });
  });

  it("rejects enabling without a repository", async () => {
    const exit = await Effect.runPromiseExit(
      configureAutopilot(
        {
          scheduler: {
            setConfig: () => Effect.succeed(scheduler),
            disarm: () => Effect.succeed(scheduler),
          },
          supervisor: { updatePolicy: () => Effect.succeed(automode) },
        },
        { enabled: true, repositories: [] },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("does not switch policy when scheduler enable fails", async () => {
    let policyCalls = 0;
    const exit = await Effect.runPromiseExit(
      configureAutopilot(
        {
          scheduler: {
            setConfig: () =>
              Effect.fail(new GitsSlotSchedulerError({ message: "scheduler unavailable" })),
            disarm: () => Effect.succeed(scheduler),
          },
          supervisor: {
            updatePolicy: () =>
              Effect.sync(() => {
                policyCalls += 1;
                return automode;
              }),
          },
        },
        { enabled: true, repositories: ["/srv/repo"] },
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(policyCalls).toBe(0);
  });

  it("disarms before pausing and stops peers before disarming an emergency stop", async () => {
    const pauseCalls: Array<readonly [string, unknown]> = [];
    await Effect.runPromise(
      configureAutopilot(
        {
          scheduler: {
            setConfig: () => Effect.succeed(scheduler),
            disarm: (input) =>
              Effect.sync(() => {
                pauseCalls.push(["scheduler.disarm", input]);
                return scheduler;
              }),
          },
          supervisor: {
            updatePolicy: (input) =>
              Effect.sync(() => {
                pauseCalls.push(["supervisor.updatePolicy", input]);
                return automode;
              }),
          },
        },
        { enabled: false, repositories: ["/srv/repo"] },
      ),
    );
    expect(pauseCalls).toEqual([
      ["scheduler.disarm", { reason: "Autopilot paused." }],
      [
        "supervisor.updatePolicy",
        {
          mode: "manual",
          allowedRepos: ["/srv/repo"],
          proposalRepos: ["/srv/repo"],
          nightlyProposalSweep: false,
        },
      ],
    ]);

    const stopCalls: Array<string> = [];
    await Effect.runPromise(
      emergencyStopAutopilot({
        scheduler: {
          disarm: () =>
            Effect.sync(() => {
              stopCalls.push("scheduler.disarm");
              return scheduler;
            }),
        },
        supervisor: {
          stopAll: () =>
            Effect.sync(() => {
              stopCalls.push("supervisor.stopAll");
              return { stoppedPeers: 1, failures: 0 };
            }),
        },
      }),
    );
    expect(stopCalls).toEqual(["supervisor.stopAll", "scheduler.disarm"]);
  });

  it("still stops peers when emergency scheduler disarm fails", async () => {
    let stopCalls = 0;
    const exit = await Effect.runPromiseExit(
      emergencyStopAutopilot({
        scheduler: {
          disarm: () => Effect.fail(new GitsSlotSchedulerError({ message: "cannot disarm" })),
        },
        supervisor: {
          stopAll: () =>
            Effect.sync(() => {
              stopCalls += 1;
              return { stoppedPeers: 1, failures: 0 };
            }),
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(stopCalls).toBe(1);
  });
});

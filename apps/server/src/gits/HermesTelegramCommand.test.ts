import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import {
  dispatchHermesTelegramCommand,
  parseHermesTelegramCommand,
} from "./HermesTelegramCommand.ts";
import { AutomodeSupervisor, type AutomodeSupervisorShape } from "./Services/AutomodeSupervisor.ts";
import { DelamainAdapter, type DelamainAdapterShape } from "./Services/DelamainAdapter.ts";
import { GitsSlotScheduler, type GitsSlotSchedulerShape } from "./Services/GitsSlotScheduler.ts";

describe("parseHermesTelegramCommand", () => {
  it.each([
    ["APPROVE goal-1", { _tag: "approve", goalId: "goal-1" }],
    ["REJECT goal-1", { _tag: "reject", goalId: "goal-1" }],
    ["DEFER goal-1", { _tag: "defer", goalId: "goal-1" }],
    ["ARM", { _tag: "arm" }],
    ["SKIP goal-1", { _tag: "skip", goalId: "goal-1" }],
    ["STOP", { _tag: "stop" }],
  ] as const)("parses %s", (text, command) => {
    expect(parseHermesTelegramCommand(text)).toEqual(command);
  });

  it("normalizes whitespace and lowercase verbs", () => {
    expect(parseHermesTelegramCommand("  approve\tgoal-1  ")).toEqual({
      _tag: "approve",
      goalId: "goal-1",
    });
  });

  it.each([
    "APPROVE goal-1 extra",
    "ARM now",
    "STOP please",
    "APPROVE",
    "DEFER",
    "SKIP",
    "EXECUTE goal-1",
    "",
  ])("rejects %j without producing an operation", (text) => {
    expect(parseHermesTelegramCommand(text)).toEqual({ _tag: "invalid" });
  });
});

function testLayer(calls: string[], killFailures = new Set<string>()) {
  const snapshot = {
    goals: [
      { peerId: "peer-running", status: "running" },
      { peerId: "peer-pending", status: "pending" },
      { peerId: "peer-completed", status: "completed" },
      { peerId: null, status: "running" },
    ],
  };
  const supervisor = {
    approveGoal: ({ goalId }: { readonly goalId: string }) => {
      calls.push(`approve:${goalId}`);
      return Effect.succeed({});
    },
    rejectGoal: ({ goalId, reason }: { readonly goalId: string; readonly reason?: string }) => {
      calls.push(`reject:${goalId}:${reason ?? ""}`);
      return Effect.succeed({});
    },
    updatePolicy: ({ killSwitchEnabled }: { readonly killSwitchEnabled?: boolean }) => {
      calls.push(`policy:${String(killSwitchEnabled)}`);
      return Effect.succeed(snapshot);
    },
    getSnapshot: () => {
      calls.push("snapshot");
      return Effect.succeed(snapshot);
    },
  } as unknown as AutomodeSupervisorShape;
  const scheduler = {
    arm: () => {
      calls.push("arm");
      return Effect.succeed({});
    },
  } as unknown as GitsSlotSchedulerShape;
  const delamain = {
    killPeer: ({ peerId }: { readonly peerId: string }) => {
      calls.push(`kill:${peerId}`);
      return killFailures.has(peerId) ? Effect.fail({ _tag: "TestFailure" }) : Effect.succeed({});
    },
  } as unknown as DelamainAdapterShape;

  return Layer.mergeAll(
    Layer.succeed(AutomodeSupervisor, supervisor),
    Layer.succeed(GitsSlotScheduler, scheduler),
    Layer.succeed(DelamainAdapter, delamain),
  );
}

async function dispatch(text: string, calls: string[], killFailures?: Set<string>) {
  return Effect.runPromise(
    dispatchHermesTelegramCommand(parseHermesTelegramCommand(text)).pipe(
      Effect.provide(testLayer(calls, killFailures)),
    ),
  );
}

describe("dispatchHermesTelegramCommand", () => {
  it("dispatches APPROVE and REJECT only to the supervisor", async () => {
    const calls: string[] = [];

    await expect(dispatch("APPROVE goal-1", calls)).resolves.toBe("Goal approved.");
    await expect(dispatch("REJECT goal-2", calls)).resolves.toBe("Goal rejected.");

    expect(calls).toEqual(["approve:goal-1", "reject:goal-2:"]);
  });

  it("rejects DEFER and SKIP with their fixed reasons", async () => {
    const calls: string[] = [];

    await dispatch("DEFER goal-1", calls);
    await dispatch("SKIP goal-2", calls);

    expect(calls).toEqual([
      "reject:goal-1:Deferred by operator.",
      "reject:goal-2:Skipped by operator.",
    ]);
  });

  it("arms only the existing scheduler", async () => {
    const calls: string[] = [];

    await expect(dispatch("ARM", calls)).resolves.toBe("Scheduler armed.");

    expect(calls).toEqual(["arm"]);
  });

  it("enables the kill switch before reading and terminating active peers", async () => {
    const calls: string[] = [];

    await expect(dispatch("STOP", calls)).resolves.toBe("Stop requested for 2 peer(s).");

    expect(calls).toEqual(["policy:true", "snapshot", "kill:peer-running", "kill:peer-pending"]);
  });

  it("keeps the kill switch enabled and reports bounded stop failures", async () => {
    const calls: string[] = [];

    await expect(dispatch("STOP", calls, new Set(["peer-pending"]))).resolves.toBe(
      "Stop requested for 1 peer(s); 1 failed.",
    );

    expect(calls[0]).toBe("policy:true");
  });

  it("returns help without calling a service for invalid commands", async () => {
    const calls: string[] = [];

    await expect(dispatch("RUN arbitrary rpc payload", calls)).resolves.toBe(
      "Commands: APPROVE <goal-id>, REJECT <goal-id>, DEFER <goal-id>, ARM, SKIP <goal-id>, STOP.",
    );

    expect(calls).toEqual([]);
  });
});

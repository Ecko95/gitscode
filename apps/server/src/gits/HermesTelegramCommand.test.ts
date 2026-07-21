import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import {
  dispatchHermesTelegramCommand,
  parseHermesTelegramCommand,
  resolveGoalToken,
  shortGoalCode,
} from "./HermesTelegramCommand.ts";
import { AutomodeSupervisor, type AutomodeSupervisorShape } from "./Services/AutomodeSupervisor.ts";
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

// Live goals visible to short-code resolution; ids match the test commands.
const SNAPSHOT_GOALS = [
  { id: "goal-1", title: "Goal one", status: "waiting-approval" },
  { id: "goal-2", title: "Goal two", status: "blocked" },
  { id: "goal-abc123", title: "Goal abc one", status: "queued" },
  { id: "goal-abc999", title: "Goal abc two", status: "queued" },
  { id: "goal-dead00", title: "Done goal", status: "completed" },
];

function testLayer(calls: string[], stopAllResult = { stoppedPeers: 2, failures: 0 }) {
  const supervisor = {
    getSnapshot: () => Effect.succeed({ goals: SNAPSHOT_GOALS }),
    approveGoal: ({ goalId }: { readonly goalId: string }) => {
      calls.push(`approve:${goalId}`);
      return Effect.succeed({});
    },
    rejectGoal: ({ goalId, reason }: { readonly goalId: string; readonly reason?: string }) => {
      calls.push(`reject:${goalId}:${reason ?? ""}`);
      return Effect.succeed({});
    },
    stopAll: () => {
      calls.push("stopAll");
      return Effect.succeed(stopAllResult);
    },
  } as unknown as AutomodeSupervisorShape;
  const scheduler = {
    arm: () => {
      calls.push("arm");
      return Effect.succeed({});
    },
  } as unknown as GitsSlotSchedulerShape;

  return Layer.mergeAll(
    Layer.succeed(AutomodeSupervisor, supervisor),
    Layer.succeed(GitsSlotScheduler, scheduler),
  );
}

async function dispatch(
  text: string,
  calls: string[],
  stopAllResult?: { stoppedPeers: number; failures: number },
) {
  return Effect.runPromise(
    dispatchHermesTelegramCommand(parseHermesTelegramCommand(text)).pipe(
      Effect.provide(testLayer(calls, stopAllResult)),
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

  it("delegates STOP to supervisor.stopAll and formats its counts", async () => {
    const calls: string[] = [];

    await expect(dispatch("STOP", calls, { stoppedPeers: 2, failures: 0 })).resolves.toBe(
      "Stop requested for 2 peer(s).",
    );

    expect(calls).toEqual(["stopAll"]);
  });

  it("reports bounded stop failures from supervisor.stopAll", async () => {
    const calls: string[] = [];

    await expect(dispatch("STOP", calls, { stoppedPeers: 1, failures: 1 })).resolves.toBe(
      "Stop requested for 1 peer(s); 1 failed.",
    );

    expect(calls).toEqual(["stopAll"]);
  });

  it("returns help without calling a service for invalid commands", async () => {
    const calls: string[] = [];

    await expect(dispatch("RUN arbitrary rpc payload", calls)).resolves.toBe(
      "Commands: APPROVE <code>, REJECT <code>, DEFER <code>, ARM, SKIP <code>, STOP. <code> is the short code from the goal message (e.g. 68a5) or a full goal id.",
    );

    expect(calls).toEqual([]);
  });

  it("resolves short codes (case-insensitive) to the full goal id", async () => {
    const calls: string[] = [];
    await expect(dispatch("APPROVE ABC1", calls)).resolves.toBe("Goal approved.");
    expect(calls).toEqual(["approve:goal-abc123"]);
  });

  it("reports ambiguity instead of guessing", async () => {
    const calls: string[] = [];
    const reply = await dispatch("APPROVE abc", calls);
    expect(reply).toContain("matches several goals");
    expect(reply).toContain("abc1");
    expect(reply).toContain("abc9");
    expect(calls).toEqual([]);
  });

  it("rejects unknown codes and does not match terminal goals", async () => {
    const calls: string[] = [];
    await expect(dispatch("APPROVE zzz9", calls)).resolves.toBe("No live goal matches 'zzz9'.");
    await expect(dispatch("APPROVE dead", calls)).resolves.toBe("No live goal matches 'dead'.");
    expect(calls).toEqual([]);
  });
});

describe("shortGoalCode / resolveGoalToken", () => {
  it("derives 4-char codes and resolves exact full ids even when terminal", () => {
    expect(shortGoalCode("goal-68a553c5-9252")).toBe("68a5");
    const exact = resolveGoalToken(SNAPSHOT_GOALS as never, "goal-dead00");
    expect(exact).toEqual({ kind: "ok", goalId: "goal-dead00" });
  });
});

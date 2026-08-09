import { describe, expect, it } from "vitest";

import { formatGateDecision, modelTierOf } from "./autopilot.logic";

describe("autopilot overview formatting", () => {
  it("maps known model tiers", () => {
    expect(modelTierOf("gpt-5.6-luna")).toBe("light");
    expect(modelTierOf("custom-model")).toBeNull();
  });

  it("formats scheduler gate decisions", () => {
    expect(formatGateDecision(null)).toBeNull();
    expect(
      formatGateDecision({
        at: "2026-07-20T00:00:00.000Z",
        allowed: false,
        reason: "outside night slot",
      }),
    ).toBe("denied — outside night slot");
  });
});

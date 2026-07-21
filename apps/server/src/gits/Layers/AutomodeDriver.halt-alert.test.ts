import { describe, expect, it } from "vitest";

import { HALT_ALERT_COOLDOWN_MS, shouldSendHaltAlert } from "./AutomodeDriver.ts";

describe("shouldSendHaltAlert", () => {
  it("sends the first alert and suppresses same-reason repeats inside the cooldown", () => {
    expect(shouldSendHaltAlert(null, "peer failed", 1000)).toBe(true);
    const last = { reason: "peer failed", at: 1000 };
    expect(shouldSendHaltAlert(last, "peer failed", 1000 + 5000)).toBe(false);
    expect(shouldSendHaltAlert(last, "peer failed", 1000 + HALT_ALERT_COOLDOWN_MS)).toBe(true);
  });

  it("always sends when the reason changes", () => {
    const last = { reason: "peer failed", at: 1000 };
    expect(shouldSendHaltAlert(last, "landing non-fast-forward", 1001)).toBe(true);
  });
});

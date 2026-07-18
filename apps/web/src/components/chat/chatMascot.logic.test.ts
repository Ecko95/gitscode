import { describe, expect, it } from "vitest";
import {
  KEYSTROKE_TICK_THROTTLE_MS,
  MASCOT_TYPING_WINDOW_MS,
  isMascotTyping,
  shouldEmitTick,
} from "./chatMascot.logic";

describe("isMascotTyping", () => {
  it("is false before any keystroke", () => {
    expect(isMascotTyping(0, 1_000)).toBe(false);
  });

  it("is true within the typing window", () => {
    expect(isMascotTyping(1_000, 1_000 + MASCOT_TYPING_WINDOW_MS - 1)).toBe(true);
  });

  it("is false once the window elapses", () => {
    expect(isMascotTyping(1_000, 1_000 + MASCOT_TYPING_WINDOW_MS)).toBe(false);
  });
});

describe("shouldEmitTick", () => {
  it("suppresses ticks inside the throttle window", () => {
    expect(shouldEmitTick(1_000, 1_000 + KEYSTROKE_TICK_THROTTLE_MS - 1)).toBe(false);
  });

  it("allows a tick once the throttle window elapses", () => {
    expect(shouldEmitTick(1_000, 1_000 + KEYSTROKE_TICK_THROTTLE_MS)).toBe(true);
  });
});

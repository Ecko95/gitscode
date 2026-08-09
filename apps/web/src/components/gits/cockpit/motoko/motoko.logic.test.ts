import { describe, expect, it } from "vitest";

import {
  computeRestorableAfterSend,
  isNearBottom,
  readCockpitDeepLink,
  visibleTranscriptWindow,
} from "./motoko.logic";

it("reads proposal and Automode notification deep links", () => {
  expect(readCockpitDeepLink("?panel=motoko&proposal=p-1")).toEqual({
    panel: "motoko",
    proposalId: "p-1",
  });
  expect(readCockpitDeepLink("?panel=autopilot&goal=g-1")).toEqual({
    panel: "autopilot",
    proposalId: null,
  });
});

describe("isNearBottom", () => {
  it("is true when scrolled to the very bottom", () => {
    expect(isNearBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it("is true within the default threshold", () => {
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it("is false when scrolled well above the bottom", () => {
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });

  it("honors a custom threshold", () => {
    const metrics = { scrollTop: 650, scrollHeight: 1000, clientHeight: 200 };
    expect(isNearBottom(metrics, 200)).toBe(true);
    expect(isNearBottom(metrics, 50)).toBe(false);
  });

  it("is true for content shorter than the viewport", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 })).toBe(true);
  });
});

describe("visibleTranscriptWindow", () => {
  it("returns everything and no hidden count under the limit", () => {
    const transcript = [1, 2, 3];
    expect(visibleTranscriptWindow(transcript, 80)).toEqual({ hiddenCount: 0, visible: [1, 2, 3] });
  });

  it("caps to the limit and reports the hidden count", () => {
    const transcript = Array.from({ length: 90 }, (_, i) => i);
    const { hiddenCount, visible } = visibleTranscriptWindow(transcript, 80);
    expect(hiddenCount).toBe(10);
    expect(visible).toHaveLength(80);
    expect(visible[0]).toBe(10);
    expect(visible.at(-1)).toBe(89);
  });

  it("defaults to the render limit constant", () => {
    const transcript = Array.from({ length: 85 }, (_, i) => i);
    expect(visibleTranscriptWindow(transcript).hiddenCount).toBe(5);
  });

  it("handles an empty transcript", () => {
    expect(visibleTranscriptWindow([], 80)).toEqual({ hiddenCount: 0, visible: [] });
  });
});

describe("computeRestorableAfterSend", () => {
  it("returns null when nothing was in flight", () => {
    expect(
      computeRestorableAfterSend({
        transcript: [{ id: "a", role: "motoko" }],
        inFlightMessage: null,
      }),
    ).toBeNull();
  });

  it("returns null when the transcript is empty", () => {
    expect(computeRestorableAfterSend({ transcript: [], inFlightMessage: "hi" })).toBeNull();
  });

  it("returns null when the last entry is the operator's own message (still pending)", () => {
    expect(
      computeRestorableAfterSend({
        transcript: [{ id: "op-1", role: "operator" }],
        inFlightMessage: "hi",
      }),
    ).toBeNull();
  });

  it("returns null when the last motoko entry carries a result (success)", () => {
    expect(
      computeRestorableAfterSend({
        transcript: [
          { id: "op-1", role: "operator" },
          { id: "motoko-1", role: "motoko", result: { status: "ok" } },
        ],
        inFlightMessage: "hi",
      }),
    ).toBeNull();
  });

  it("returns the entry id and message when the last motoko entry has no result (error)", () => {
    expect(
      computeRestorableAfterSend({
        transcript: [
          { id: "op-1", role: "operator" },
          { id: "motoko-err-1", role: "motoko" },
        ],
        inFlightMessage: "please deploy",
      }),
    ).toEqual({ entryId: "motoko-err-1", message: "please deploy" });
  });
});

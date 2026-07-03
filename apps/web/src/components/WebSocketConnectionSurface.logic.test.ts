import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
  shouldTriggerAuthRejectedProbe,
} from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("does not auto-reconnect when auth-rejected", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          closeCode: 1006,
          reconnectPhase: "auth-rejected",
        }),
        "focus",
      ),
    ).toBe(false);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          closeCode: 1006,
          reconnectPhase: "auth-rejected",
        }),
        "online",
      ),
    ).toBe(false);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });
});

describe("shouldTriggerAuthRejectedProbe (W3.4)", () => {
  it("triggers probe on 1006 close during reconnect in waiting phase", () => {
    expect(
      shouldTriggerAuthRejectedProbe(
        makeStatus({
          hasConnected: true,
          closeCode: 1006,
          phase: "disconnected",
          reconnectPhase: "waiting",
          reconnectAttemptCount: 2,
        }),
      ),
    ).toBe(true);
  });

  it("triggers probe on 1006 close when retries are exhausted", () => {
    expect(
      shouldTriggerAuthRejectedProbe(
        makeStatus({
          hasConnected: true,
          closeCode: 1006,
          phase: "disconnected",
          reconnectPhase: "exhausted",
        }),
      ),
    ).toBe(true);
  });

  it("does not trigger probe when already auth-rejected", () => {
    expect(
      shouldTriggerAuthRejectedProbe(
        makeStatus({
          hasConnected: true,
          closeCode: 1006,
          phase: "disconnected",
          reconnectPhase: "auth-rejected",
        }),
      ),
    ).toBe(false);
  });

  it("does not trigger probe on transient close codes other than 1006", () => {
    expect(
      shouldTriggerAuthRejectedProbe(
        makeStatus({
          hasConnected: true,
          closeCode: 1013,
          phase: "disconnected",
          reconnectPhase: "waiting",
        }),
      ),
    ).toBe(false);
  });

  it("does not trigger probe when not previously connected (initial connect failure)", () => {
    expect(
      shouldTriggerAuthRejectedProbe(
        makeStatus({
          hasConnected: false,
          closeCode: 1006,
          phase: "disconnected",
          reconnectPhase: "waiting",
        }),
      ),
    ).toBe(false);
  });

  it("does not trigger probe during an active retry attempt", () => {
    expect(
      shouldTriggerAuthRejectedProbe(
        makeStatus({
          hasConnected: true,
          closeCode: 1006,
          phase: "connecting",
          reconnectPhase: "attempting",
        }),
      ),
    ).toBe(false);
  });
});

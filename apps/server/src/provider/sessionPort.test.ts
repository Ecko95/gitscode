import { describe, expect, it } from "vitest";

import { sessionPortEnv, sessionPortForSessionId } from "./sessionPort.ts";

describe("sessionPortForSessionId", () => {
  it("returns a stable high port for the same session id", () => {
    const first = sessionPortForSessionId("thread-session-a");
    const second = sessionPortForSessionId("thread-session-a");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(30_000);
    expect(first).toBeLessThan(40_000);
  });

  it("spreads typical session ids across different ports", () => {
    const ports = Array.from({ length: 128 }, (_, index) =>
      sessionPortForSessionId(`thread-${index}`),
    );

    expect(new Set(ports).size).toBe(ports.length);
  });

  it("serializes the port as GITS_PORT env", () => {
    expect(sessionPortEnv("thread-session-a")).toEqual({
      GITS_PORT: String(sessionPortForSessionId("thread-session-a")),
    });
  });
});

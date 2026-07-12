import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ServerProcessResourceHistoryInput, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProcessResourceHistoryInput = Schema.decodeUnknownSync(
  ServerProcessResourceHistoryInput,
);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});

describe("ServerProcessResourceHistoryInput", () => {
  it.each([
    { windowMs: 999, bucketMs: 5_000 },
    { windowMs: 3_600_001, bucketMs: 5_000 },
    { windowMs: 60_000, bucketMs: 4_999 },
    { windowMs: 60_000, bucketMs: 3_600_001 },
  ])("rejects durations outside the supported bounds", (input) => {
    expect(() => decodeServerProcessResourceHistoryInput(input)).toThrow();
  });

  it.each([
    { windowMs: 1_000, bucketMs: 5_000 },
    { windowMs: 3_600_000, bucketMs: 3_600_000 },
  ])("accepts inclusive duration bounds", (input) => {
    expect(decodeServerProcessResourceHistoryInput(input)).toEqual(input);
  });
});

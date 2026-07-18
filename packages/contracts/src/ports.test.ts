import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { PortRecord, PortsListInput } from "./ports.ts";

const decodePortRecord = Schema.decodeUnknownSync(PortRecord);
const decodePortsListInput = Schema.decodeUnknownSync(PortsListInput);

const validPort = {
  id: "127.0.0.1:5173",
  remoteHost: "127.0.0.1",
  remotePort: 5173,
  protocol: "http",
  label: "Web dev",
  sources: ["configured", "listener"],
  listenerStatus: "ready",
  ownership: "unmanaged",
  commandId: "web-dev",
  pid: 123,
  processName: "node",
  lastSeenAt: "2026-07-17T20:00:00.000Z",
  supervisedStatus: "stopped",
  exposureStatus: "none",
} as const;

describe("ports contracts", () => {
  it("accepts bounded loopback port records", () => {
    expect(decodePortRecord(validPort)).toEqual(validPort);
    expect(decodePortRecord({ ...validPort, remoteHost: "127.12.34.56" })).toMatchObject({
      remoteHost: "127.12.34.56",
    });
    expect(decodePortRecord({ ...validPort, remoteHost: "::1" })).toMatchObject({
      remoteHost: "::1",
    });
  });

  it("rejects invalid ports and non-loopback targets", () => {
    for (const remotePort of [0, 65_536, 1.5]) {
      expect(() => decodePortRecord({ ...validPort, remotePort })).toThrow();
    }
    for (const remoteHost of ["0.0.0.0", "10.0.0.4", "example.com", "127.0.0.999"]) {
      expect(() => decodePortRecord({ ...validPort, remoteHost })).toThrow();
    }
  });

  it("keeps public and Tailnet endpoint fields out of the snapshot", () => {
    const decoded = decodePortRecord({
      ...validPort,
      publicUrl: "https://public.example.test",
      tailnetUrl: "https://private.tail.test",
    });

    expect(decoded).not.toHaveProperty("publicUrl");
    expect(decoded).not.toHaveProperty("tailnetUrl");
  });

  it("scopes list requests to a project and optional thread", () => {
    expect(decodePortsListInput({ projectDir: "/repo", threadId: "thread-1" })).toEqual({
      projectDir: "/repo",
      threadId: "thread-1",
    });
    expect(decodePortsListInput({ projectDir: "/repo" })).toEqual({ projectDir: "/repo" });
  });
});

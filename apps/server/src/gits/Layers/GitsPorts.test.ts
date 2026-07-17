import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { makeGitsPorts, mergePortFacts, parseSsListeners, type PortFact } from "./GitsPorts.ts";

const scannedAt = "2026-07-17T20:00:00.000Z";

const baseCommand = {
  id: "web-dev",
  name: "Web dev",
  description: null,
  cwd: "/repo/apps/web",
  command: "bun run dev",
  localPort: 5173,
  localHost: "127.0.0.1",
  publishOnTailnet: false,
  servePort: null,
  previewUrl: null,
  launchCommand: "bun run dev",
} as const;

describe("GitsPorts", () => {
  it("merges configured, terminal, listener, and manual facts by environment port", () => {
    const facts: PortFact[] = [
      {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        protocol: "http",
        source: "configured",
        label: "Web dev",
        commandId: "web-dev",
      },
      {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        protocol: "http",
        source: "terminal",
        ownership: "gits-terminal",
        threadId: "thread-1" as never,
        terminalId: "terminal-1",
      },
      {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        protocol: "tcp",
        source: "listener",
        listenerStatus: "ready",
        pid: 123,
        processName: "node",
        lastSeenAt: scannedAt,
      },
      {
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        protocol: "http",
        source: "manual",
      },
    ];

    expect(mergePortFacts(facts)).toEqual([
      {
        id: "127.0.0.1:5173",
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        protocol: "http",
        label: "Web dev",
        sources: ["configured", "terminal", "listener", "manual"],
        listenerStatus: "ready",
        ownership: "gits-terminal",
        threadId: "thread-1",
        terminalId: "terminal-1",
        commandId: "web-dev",
        pid: 123,
        processName: "node",
        lastSeenAt: scannedAt,
        supervisedStatus: "stopped",
        exposureStatus: "none",
      },
    ]);
  });

  it("parses only loopback-reachable TCP listeners", () => {
    const facts = parseSsListeners(
      [
        'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=123,fd=22))',
        'LISTEN 0 128 0.0.0.0:8123 0.0.0.0:* users:(("bun",pid=456,fd=18))',
        'LISTEN 0 128 [::1]:9000 [::]:* users:(("python3",pid=789,fd=3))',
        'LISTEN 0 128 10.0.0.4:7000 0.0.0.0:* users:(("node",pid=999,fd=4))',
      ].join("\n"),
      scannedAt,
    );

    expect(facts).toEqual([
      expect.objectContaining({
        remoteHost: "127.0.0.1",
        remotePort: 5173,
        pid: 123,
        processName: "node",
      }),
      expect.objectContaining({
        remoteHost: "127.0.0.1",
        remotePort: 8123,
        pid: 456,
        processName: "bun",
      }),
      expect.objectContaining({
        remoteHost: "::1",
        remotePort: 9000,
        pid: 789,
        processName: "python3",
      }),
    ]);
  });

  it("combines configured and detected ports without inferring process ownership", async () => {
    const readListeners = vi.fn(async () =>
      [
        'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=123,fd=22))',
        'LISTEN 0 128 127.0.0.1:8123 0.0.0.0:* users:(("node",pid=456,fd=18))',
        'LISTEN 0 128 127.0.0.1:13773 0.0.0.0:* users:(("node",pid=1,fd=10))',
        'LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=2,fd=9))',
      ].join("\n"),
    );
    const ports = makeGitsPorts({
      controlPort: 13_773,
      now: () => scannedAt,
      readListeners,
      listDevCommands: () =>
        Effect.succeed({
          projectDir: "/repo",
          configPath: "/repo/.gits/dev-commands.json",
          tailscaleAvailable: false,
          magicDnsName: null,
          commands: [baseCommand],
          warnings: [],
        }),
    });

    const result = await Effect.runPromise(
      ports.list({ projectDir: "/repo", threadId: "thread-1" as never }),
    );

    expect(readListeners).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ projectDir: "/repo", threadId: "thread-1", scannedAt });
    expect(result.ports.map((port) => port.remotePort)).toEqual([5173, 8123]);
    expect(result.ports[0]).toMatchObject({
      label: "Web dev",
      sources: ["configured", "listener"],
      listenerStatus: "ready",
      ownership: "unmanaged",
      processName: "node",
    });
    expect(result.ports[1]).toMatchObject({
      sources: ["listener"],
      ownership: "unmanaged",
    });
  });

  it("keeps configured rows when listener discovery is unavailable", async () => {
    const ports = makeGitsPorts({
      controlPort: 13_773,
      now: () => scannedAt,
      readListeners: async () => {
        throw new Error("ss unavailable with sensitive stderr");
      },
      listDevCommands: () =>
        Effect.succeed({
          projectDir: "/repo",
          configPath: null,
          tailscaleAvailable: false,
          magicDnsName: null,
          commands: [baseCommand],
          warnings: [],
        }),
    });

    const result = await Effect.runPromise(ports.list({ projectDir: "/repo" }));

    expect(result.ports).toEqual([
      expect.objectContaining({ remotePort: 5173, listenerStatus: "stopped" }),
    ]);
    expect(result.warnings).toEqual(["Listener discovery is unavailable."]);
    expect(JSON.stringify(result)).not.toContain("sensitive stderr");
  });
});

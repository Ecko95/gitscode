import type { KnownTerminalSession } from "@t3tools/client-runtime";
import type { PortRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildPortUrl, createManualPort, mergePortInventory } from "./BrowserPreviewPanel.logic";

const configuredPort: PortRecord = {
  id: "127.0.0.1:5173",
  remoteHost: "127.0.0.1",
  remotePort: 5173,
  protocol: "http",
  label: "Web dev",
  sources: ["configured"],
  listenerStatus: "stopped",
  ownership: "unmanaged",
  commandId: "web-dev",
  supervisedStatus: "stopped",
  exposureStatus: "none",
};

function terminalSession(overrides: {
  terminalId: string;
  buffer: string;
  hasRunningSubprocess?: boolean;
}): KnownTerminalSession {
  return {
    target: {
      environmentId: "environment-1" as never,
      threadId: "thread-1" as never,
      terminalId: overrides.terminalId,
    },
    state: {
      summary: {
        threadId: "thread-1",
        terminalId: overrides.terminalId,
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 123,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: overrides.hasRunningSubprocess ?? true,
        label: "vite",
        updatedAt: "2026-07-17T21:00:00.000Z",
      },
      buffer: overrides.buffer,
      status: "running",
      error: null,
      hasRunningSubprocess: overrides.hasRunningSubprocess ?? true,
      updatedAt: "2026-07-17T21:00:00.000Z",
      version: 1,
    },
  };
}

describe("Ports & Browser inventory", () => {
  it("merges configured, terminal, listener, and manual rows without duplicates", () => {
    const listenerPort: PortRecord = {
      ...configuredPort,
      sources: ["listener"],
      listenerStatus: "ready",
      pid: 999,
      processName: "node",
    };
    const sessions = [
      terminalSession({ terminalId: "terminal-0", buffer: "http://127.0.0.1:5173" }),
      terminalSession({
        terminalId: "gits-dev-web-dev",
        buffer: "ready at http://localhost:5173/path\nexternal https://example.com",
      }),
      terminalSession({ terminalId: "terminal-2", buffer: "http://127.0.0.1:4173" }),
    ];

    const result = mergePortInventory({
      serverPorts: [configuredPort, listenerPort],
      terminalSessions: sessions,
      manualPorts: [createManualPort(9000, "https")],
    });

    expect(result.map((port) => port.remotePort)).toEqual([4173, 5173, 9000]);
    expect(result.find((port) => port.remotePort === 5173)).toMatchObject({
      label: "Web dev",
      sources: ["configured", "terminal", "listener"],
      listenerStatus: "ready",
      ownership: "gits-terminal",
      pid: 999,
      terminalId: "gits-dev-web-dev",
    });
    expect(result.find((port) => port.remotePort === 4173)).toMatchObject({
      sources: ["terminal"],
      ownership: "unmanaged",
    });
    expect(result.find((port) => port.remotePort === 9000)).toMatchObject({
      protocol: "https",
      sources: ["manual"],
    });
  });

  it("builds exact loopback URLs only for HTTP protocols", () => {
    expect(buildPortUrl(configuredPort)).toBe("http://127.0.0.1:5173/");
    expect(buildPortUrl({ ...configuredPort, remoteHost: "::1", protocol: "https" })).toBe(
      "https://[::1]:5173/",
    );
    expect(buildPortUrl({ ...configuredPort, protocol: "tcp" })).toBeNull();
  });

  it("rejects invalid manual port numbers", () => {
    expect(() => createManualPort(0, "http")).toThrow("between 1 and 65535");
    expect(() => createManualPort(65_536, "http")).toThrow("between 1 and 65535");
  });
});

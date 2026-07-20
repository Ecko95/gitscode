import { describe, expect, it, vi } from "vitest";

import {
  detachAllDevSessions,
  detachDevSession,
  makeDevThreadId,
  reduceDevCommandEvent,
  resolveDevStopThreadId,
  type DevCommandSessionState,
} from "./useDevCommandSessions";

// Regression coverage for the 2026-07-07 audit's two red dev-terminal findings:
// (1) Stop closing the wrong thread after a project switch, (2) the session
// map + attach subscriptions bleeding across a target-project change.

describe("makeDevThreadId", () => {
  it("keys the thread by project root — two projects never share a thread", () => {
    expect(makeDevThreadId("/repo/a")).not.toBe(makeDevThreadId("/repo/b"));
  });
});

describe("resolveDevStopThreadId", () => {
  it("targets the session's own threadId captured at open time, not the current selection", () => {
    // Command started under project A; user has since switched the selector to B.
    const openedUnderA = makeDevThreadId("/repo/a");
    expect(resolveDevStopThreadId(openedUnderA, "/repo/b")).toBe(openedUnderA);
    expect(resolveDevStopThreadId(openedUnderA, "/repo/b")).not.toBe(makeDevThreadId("/repo/b"));
  });

  it("falls back to the current selection when no session was ever recorded", () => {
    expect(resolveDevStopThreadId(undefined, "/repo/b")).toBe(makeDevThreadId("/repo/b"));
  });
});

describe("detachDevSession", () => {
  it("detaches and forgets a single command without touching others", () => {
    const detachA = vi.fn();
    const detachB = vi.fn();
    const map = new Map([
      ["cmd-a", detachA],
      ["cmd-b", detachB],
    ]);
    detachDevSession(map, "cmd-a");
    expect(detachA).toHaveBeenCalledOnce();
    expect(detachB).not.toHaveBeenCalled();
    expect(map.has("cmd-a")).toBe(false);
    expect(map.has("cmd-b")).toBe(true);
  });

  it("is a no-op for a command with no live subscription", () => {
    const map = new Map<string, () => void>();
    expect(() => detachDevSession(map, "missing")).not.toThrow();
  });
});

describe("detachAllDevSessions", () => {
  it("detaches every subscription and clears the map on a target-project change", () => {
    const detachA = vi.fn();
    const detachB = vi.fn();
    const map = new Map([
      ["cmd-a", detachA],
      ["cmd-b", detachB],
    ]);
    detachAllDevSessions(map);
    expect(detachA).toHaveBeenCalledOnce();
    expect(detachB).toHaveBeenCalledOnce();
    expect(map.size).toBe(0);
  });
});

describe("reduceDevCommandEvent", () => {
  const base: DevCommandSessionState = {
    threadId: "gits-dev:/repo/a",
    terminalId: "gits-dev-cmd-1",
    status: "idle",
    log: "",
    exitCode: null,
    label: null,
    updatedAt: null,
    pid: null,
  };

  it("applies a snapshot, preserving the session's own threadId", () => {
    const next = reduceDevCommandEvent(base, {
      type: "snapshot",
      snapshot: {
        threadId: base.threadId,
        terminalId: "gits-dev-cmd-1",
        cwd: "/repo/a",
        worktreePath: null,
        status: "running",
        pid: 123,
        history: "hello",
        exitCode: null,
        exitSignal: null,
        label: "dev",
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    });
    expect(next.threadId).toBe(base.threadId);
    expect(next.status).toBe("running");
    expect(next.log).toBe("hello");
    expect(next.pid).toBe(123);
  });

  it("marks exited sessions with the exit code and clears pid", () => {
    const running: DevCommandSessionState = { ...base, status: "running", pid: 42 };
    const next = reduceDevCommandEvent(running, {
      type: "exited",
      threadId: base.threadId,
      terminalId: base.terminalId,
      exitCode: 0,
      exitSignal: null,
    });
    expect(next.status).toBe("exited");
    expect(next.exitCode).toBe(0);
    expect(next.pid).toBeNull();
  });

  it("marks any other stream event (e.g. closed) as closed", () => {
    const next = reduceDevCommandEvent(base, {
      type: "closed",
      threadId: base.threadId,
      terminalId: base.terminalId,
    });
    expect(next.status).toBe("closed");
    expect(next.pid).toBeNull();
  });
});

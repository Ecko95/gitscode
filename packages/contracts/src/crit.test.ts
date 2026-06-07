import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  CritEnsureSidecarRequest,
  CritError,
  CritSidecarStatusRequest,
  CritSidecarStatusResponse,
  CritTurnRequest,
  CritTurnResponse,
  CritTurnStatusResponse,
} from "./crit.ts";

const decodeEnsureRequest = Schema.decodeUnknownSync(CritEnsureSidecarRequest);
const decodeStatusRequest = Schema.decodeUnknownSync(CritSidecarStatusRequest);
const decodeStatusResponse = Schema.decodeUnknownSync(CritSidecarStatusResponse);
const decodeTurnRequest = Schema.decodeUnknownSync(CritTurnRequest);
const decodeTurnResponse = Schema.decodeUnknownSync(CritTurnResponse);
const decodeTurnStatusResponse = Schema.decodeUnknownSync(CritTurnStatusResponse);

describe("CritEnsureSidecarRequest", () => {
  it("decodes a workspace/branch/thread request", () => {
    const parsed = decodeEnsureRequest({
      workspaceRoot: "/home/me/project",
      branch: "feat/crit",
      threadId: "thread-123",
    });

    expect(parsed.workspaceRoot).toBe("/home/me/project");
    expect(parsed.branch).toBe("feat/crit");
    expect(parsed.threadId).toBe("thread-123");
  });

  it("rejects an empty workspace root", () => {
    expect(() =>
      decodeEnsureRequest({ workspaceRoot: "  ", branch: "feat", threadId: "t" }),
    ).toThrow();
  });
});

describe("CritSidecarStatusRequest", () => {
  it("decodes a workspace-only request", () => {
    expect(decodeStatusRequest({ workspaceRoot: "/repo" }).workspaceRoot).toBe("/repo");
  });
});

describe("CritSidecarStatusResponse", () => {
  it("accepts each lifecycle status with a url", () => {
    for (const status of ["starting", "ready", "crashed", "stopped"] as const) {
      const parsed = decodeStatusResponse({ status, url: "http://127.0.0.1:4400" });
      expect(parsed.status).toBe(status);
      expect(parsed.url).toBe("http://127.0.0.1:4400");
    }
  });

  it("accepts a null url", () => {
    expect(decodeStatusResponse({ status: "stopped", url: null }).url).toBeNull();
  });

  it("rejects an unknown status literal", () => {
    expect(() => decodeStatusResponse({ status: "unknown", url: null })).toThrow();
  });
});

describe("CritTurnRequest", () => {
  it("decodes a thread/text turn request", () => {
    const parsed = decodeTurnRequest({ threadId: "thread-123", text: "review this" });
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.text).toBe("review this");
  });

  it("rejects a missing threadId", () => {
    expect(() => decodeTurnRequest({ text: "hello" })).toThrow();
  });

  it("rejects empty text", () => {
    expect(() => decodeTurnRequest({ threadId: "thread-123", text: "  " })).toThrow();
  });
});

describe("CritTurnResponse", () => {
  it("decodes a prior turn id", () => {
    expect(decodeTurnResponse({ priorTurnId: "turn-1" }).priorTurnId).toBe("turn-1");
  });

  it("accepts a null prior turn id", () => {
    expect(decodeTurnResponse({ priorTurnId: null }).priorTurnId).toBeNull();
  });
});

describe("CritTurnStatusResponse", () => {
  it("decodes each terminal/pending state", () => {
    for (const state of ["pending", "completed", "error", "interrupted"] as const) {
      const parsed = decodeTurnStatusResponse({ state, assistantMessageId: null, reply: null });
      expect(parsed.state).toBe(state);
    }
  });

  it("decodes a completed status with a reply", () => {
    const parsed = decodeTurnStatusResponse({
      state: "completed",
      assistantMessageId: "msg-1",
      reply: "done",
    });
    expect(parsed.assistantMessageId).toBe("msg-1");
    expect(parsed.reply).toBe("done");
  });

  it("rejects an unknown state literal", () => {
    expect(() =>
      decodeTurnStatusResponse({ state: "running", assistantMessageId: null, reply: null }),
    ).toThrow();
  });
});

describe("CritError", () => {
  it("is a tagged error carrying a message", () => {
    const error = new CritError({ message: "boom" });
    expect(error._tag).toBe("CritError");
    expect(error.message).toBe("boom");
  });
});

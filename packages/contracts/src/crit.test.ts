import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  CritEnsureSidecarRequest,
  CritError,
  CritSidecarStatusRequest,
  CritSidecarStatusResponse,
} from "./crit.ts";

const decodeEnsureRequest = Schema.decodeUnknownSync(CritEnsureSidecarRequest);
const decodeStatusRequest = Schema.decodeUnknownSync(CritSidecarStatusRequest);
const decodeStatusResponse = Schema.decodeUnknownSync(CritSidecarStatusResponse);

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

describe("CritError", () => {
  it("is a tagged error carrying a message", () => {
    const error = new CritError({ message: "boom" });
    expect(error._tag).toBe("CritError");
    expect(error.message).toBe("boom");
  });
});

import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  BrowserPreviewControlInput,
  BrowserPreviewStatus,
  BrowserPreviewThreadInput,
} from "./browser-preview.ts";

const decode_thread_input = Schema.decodeUnknownSync(BrowserPreviewThreadInput);
const decode_control_input = Schema.decodeUnknownSync(BrowserPreviewControlInput);
const decode_status = Schema.decodeUnknownSync(BrowserPreviewStatus);

describe("browser preview contracts", () => {
  it("decodes a thread-scoped preview request", () => {
    expect(decode_thread_input({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

  it("rejects unsupported control actions", () => {
    expect(() =>
      decode_control_input({
        threadId: "thread-1",
        action: "restart",
      }),
    ).toThrow();
  });

  it("decodes browser navigation with a URL", () => {
    expect(
      decode_control_input({
        threadId: "thread-1",
        action: "navigate",
        url: "http://localhost:8080",
      }),
    ).toMatchObject({ action: "navigate", url: "http://localhost:8080" });
  });

  it("decodes a direct browser instruction", () => {
    expect(
      decode_control_input({
        threadId: "thread-1",
        action: "instruct",
        instruction: "click Continue",
      }),
    ).toMatchObject({ action: "instruct", instruction: "click Continue" });
  });

  it("decodes a live preview status", () => {
    expect(
      decode_status({
        available: true,
        status: "live",
        previewPath: "/api/browser-preview/thread-1",
        terminalUrl: "http://localhost:39369",
        expiresAt: "2026-07-12T12:00:00.000Z",
        message: null,
      }),
    ).toMatchObject({ available: true, status: "live" });
  });
});

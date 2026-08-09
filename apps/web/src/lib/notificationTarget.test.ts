import { describe, expect, it } from "vitest";

import { notificationTargetUrl } from "./notificationTarget";

describe("notificationTargetUrl", () => {
  it("keeps same-origin deep links and rejects external targets", () => {
    expect(notificationTargetUrl("/gits?notificationTest=proposal", "https://gits.example")).toBe(
      "https://gits.example/gits?notificationTest=proposal",
    );
    expect(notificationTargetUrl("https://evil.example/", "https://gits.example")).toBe(
      "https://gits.example/",
    );
  });
});

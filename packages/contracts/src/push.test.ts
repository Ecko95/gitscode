import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { WebPushTestInput } from "./push.ts";

const decodeWebPushTestInput = Schema.decodeUnknownSync(WebPushTestInput);

describe("WebPushTestInput", () => {
  it("accepts only fixed notification test kinds", () => {
    expect(
      decodeWebPushTestInput({ endpoint: "https://push.example/device", kind: "proposal" }),
    ).toEqual({ endpoint: "https://push.example/device", kind: "proposal" });
    expect(() =>
      decodeWebPushTestInput({ endpoint: "https://push.example/device", kind: "custom" }),
    ).toThrow();
  });
});

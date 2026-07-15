import { describe, expect, it } from "vitest";

import { collectDueResetWarnings } from "./codexResetWarnings";

const now = Date.parse("2026-07-15T12:00:00Z");

describe("collectDueResetWarnings", () => {
  it.each([
    ["outside", 49, [], []],
    ["48-hour", 47, [], ["credit:48"]],
    ["24-hour", 23, ["credit:48"], ["credit:24"]],
    ["deduplicated", 23, ["credit:48", "credit:24"], []],
    ["expired", -1, [], []],
  ])("selects %s warnings", (_name, hours, delivered, expected) => {
    const warnings = collectDueResetWarnings(
      [{ id: "credit", expiresAt: new Date(now + Number(hours) * 3_600_000).toISOString() }],
      new Set(delivered as string[]),
      now,
    );
    expect(warnings.map((warning) => warning.key)).toEqual(expected);
  });

  it("ignores credits without an expiry", () => {
    expect(collectDueResetWarnings([{ id: "credit", expiresAt: null }], new Set(), now)).toEqual(
      [],
    );
  });
});

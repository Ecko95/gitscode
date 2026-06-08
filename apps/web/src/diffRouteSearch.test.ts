import { describe, expect, it } from "vitest";

import { parseDiffRouteSearch, stripDiffSearchParams } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses the native diff value", () => {
    expect(parseDiffRouteSearch({ diff: "1" }).diff).toBe("1");
  });

  it("parses the crit value", () => {
    expect(parseDiffRouteSearch({ diff: "crit" }).diff).toBe("crit");
  });

  it("drops unknown diff values", () => {
    expect(parseDiffRouteSearch({ diff: "bogus" }).diff).toBeUndefined();
  });

  it("keeps diffTurnId/diffFilePath for native diff but not for crit", () => {
    const native = parseDiffRouteSearch({ diff: "1", diffTurnId: "turn-1", diffFilePath: "a.ts" });
    expect(native.diffTurnId).toBe("turn-1");
    expect(native.diffFilePath).toBe("a.ts");
    const crit = parseDiffRouteSearch({ diff: "crit", diffTurnId: "turn-1", diffFilePath: "a.ts" });
    expect(crit.diffTurnId).toBeUndefined();
    expect(crit.diffFilePath).toBeUndefined();
  });

  it("strips all diff params", () => {
    expect(stripDiffSearchParams({ diff: "crit", other: "keep" })).toEqual({ other: "keep" });
  });
});

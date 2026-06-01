import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { GitsBuildInfo } from "./gits.ts";

const decodeGitsBuildInfo = Schema.decodeUnknownSync(GitsBuildInfo);

describe("GitsBuildInfo", () => {
  it("accepts nullable build provenance fields", () => {
    const parsed = decodeGitsBuildInfo({
      branch: "feat/gits-tailnet-hosting-refresh",
      commit: "abcdef1234567890",
      time: "2026-06-02T10:00:00.000Z",
      dirty: false,
      sourcePath: "/srv/t3code/current",
    });

    expect(parsed.branch).toBe("feat/gits-tailnet-hosting-refresh");
    expect(parsed.commit).toBe("abcdef1234567890");
    expect(parsed.time).toBe("2026-06-02T10:00:00.000Z");
    expect(parsed.dirty).toBe(false);
    expect(parsed.sourcePath).toBe("/srv/t3code/current");
  });
});

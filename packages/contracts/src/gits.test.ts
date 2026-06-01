import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { GitsBuildInfo, GitsSkillInventorySnapshot } from "./gits.ts";

const decodeGitsBuildInfo = Schema.decodeUnknownSync(GitsBuildInfo);
const decodeGitsSkillInventorySnapshot = Schema.decodeUnknownSync(GitsSkillInventorySnapshot);

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

describe("GitsSkillInventorySnapshot", () => {
  it("accepts local provider skill inventory fields", () => {
    const parsed = decodeGitsSkillInventorySnapshot({
      scannedAt: "2026-06-02T10:00:00.000Z",
      skills: [
        {
          id: "codex:skill:/home/test/.codex/skills/review/SKILL.md",
          provider: "codex",
          kind: "skill",
          name: "review",
          title: "Review",
          description: "Review changed source files.",
          path: "/home/test/.codex/skills/review/SKILL.md",
          sourceRoot: "/home/test/.codex/skills",
          rating: null,
          review: null,
          usageCount: 0,
          lastUsedAt: null,
          lastModifiedAt: "2026-06-02T09:00:00.000Z",
          portability: "native",
          tags: ["codex"],
        },
      ],
      providers: [
        {
          provider: "codex",
          totalCount: 1,
          nativeCount: 1,
          missingPortCount: 0,
          ratedCount: 0,
          reviewedCount: 0,
        },
      ],
      totals: {
        skillCount: 1,
        providerCount: 1,
        ratedCount: 0,
        reviewedCount: 0,
        missingPortCount: 0,
        hermesCandidateCount: 0,
      },
      warnings: [],
      insights: [],
    });

    expect(parsed.skills[0]?.provider).toBe("codex");
    expect(parsed.totals.skillCount).toBe(1);
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeGitsSkillInventoryResolver } from "./GitsSkillInventory.ts";

describe("GitsSkillInventoryResolverLive", () => {
  it.effect("scans local Codex, Claude, and Cursor skills read-only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-gits-skills-",
      });
      const codexRoot = path.join(tempDir, "codex-skills");
      const claudeRoot = path.join(tempDir, "claude-agents");
      const cursorRoot = path.join(tempDir, "cursor-rules");
      yield* fileSystem.makeDirectory(path.join(codexRoot, "review"), { recursive: true });
      yield* fileSystem.makeDirectory(claudeRoot, { recursive: true });
      yield* fileSystem.makeDirectory(cursorRoot, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(codexRoot, "review", "SKILL.md"),
        "# Review\nReview changed source files for correctness.",
      );
      yield* fileSystem.writeFileString(
        path.join(claudeRoot, "review.md"),
        "---\ndescription: Claude review assistant.\n---\n# Review",
      );
      yield* fileSystem.writeFileString(
        path.join(cursorRoot, "ui.mdc"),
        "# UI Rules\nKeep controls compact and scan-friendly.",
      );

      const resolver = makeGitsSkillInventoryResolver({
        now: () => "2026-06-02T10:00:00.000Z",
        scanTargets: [
          { provider: "codex", kind: "skill", rootPath: codexRoot, maxDepth: 2 },
          { provider: "claude", kind: "agent", rootPath: claudeRoot, maxDepth: 1 },
          { provider: "cursor", kind: "rule", rootPath: cursorRoot, maxDepth: 1 },
        ],
      });
      const snapshot = yield* resolver.getSnapshot();

      expect(snapshot.scannedAt).toBe("2026-06-02T10:00:00.000Z");
      expect(snapshot.totals.skillCount).toBe(3);
      expect(snapshot.providers.map((provider) => provider.provider).sort()).toEqual([
        "claude",
        "codex",
        "cursor",
      ]);
      expect(snapshot.skills.find((skill) => skill.provider === "codex")?.portability).toBe(
        "native",
      );
      expect(snapshot.skills.find((skill) => skill.provider === "claude")?.portability).toBe(
        "ported",
      );
      expect(snapshot.skills.find((skill) => skill.provider === "cursor")?.portability).toBe(
        "missing-port",
      );
      expect(snapshot.insights.some((insight) => insight.kind === "missing-provider-port")).toBe(
        true,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

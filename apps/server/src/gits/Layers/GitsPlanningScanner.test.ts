// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { GitsPlanningScanner } from "../Services/GitsPlanningScanner.ts";
import { GitsPlanningScannerLive } from "./GitsPlanningScanner.ts";

function writeFile(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

describe("GitsPlanningScannerLive", () => {
  it.effect("reads project client metadata, milestones, phases, gates, and repo identity", () =>
    Effect.gen(function* () {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gits-planning-scanner-"));
      try {
        writeFile(
          path.join(root, ".git", "config"),
          [
            '[remote "origin"]',
            "\turl = git@github.com:joshuaduffill/t3code.git",
            '[branch "main"]',
            "\tmerge = refs/heads/main",
            "",
          ].join("\n"),
        );
        writeFile(path.join(root, ".planning", "PROJECT.md"), "client: Ghost Labs\n");
        writeFile(path.join(root, ".planning", "milestones", "v1", "README.md"), "# v1\n");
        writeFile(path.join(root, ".planning", "phases", "01-alpha", "PLAN.md"), "# Plan\n");
        writeFile(
          path.join(root, ".planning", "phases", "01-alpha", "VERIFICATION.md"),
          "# Verification\npassed\n",
        );

        const scanner = yield* GitsPlanningScanner;
        const snapshot = yield* scanner.scan({
          projects: [
            {
              id: ProjectId.make("project-gits"),
              title: "GITS",
              workspaceRoot: root,
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          threads: [],
          fallbackCwd: root,
        });

        const project = snapshot.projects[0];
        assert.equal(project?.project.clientName, "Ghost Labs");
        assert.equal(project?.project.planning.state, "present");
        assert.equal(project?.project.planning.milestoneCount, 1);
        assert.equal(project?.project.planning.phaseCount, 1);
        assert.equal(project?.project.repo.remoteUrl, "git@github.com:joshuaduffill/t3code.git");
        assert.equal(project?.project.repo.defaultBranch, "main");
        assert.equal(project?.phases[0]?.id, "01-alpha");
        assert.equal(project?.phases[0]?.status, "verified");
        assert.equal(project?.verificationGates.length, 2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(GitsPlanningScannerLive)),
  );
});

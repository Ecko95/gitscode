import { describe, expect, it } from "vitest";
import {
  build_ensure_integration_branch_commands,
  build_land_slice_commands,
} from "./AutomodeLandingCommands.ts";

describe("automode landing commands", () => {
  it("creates the integration branch from the base ref on origin", () => {
    const cmds = build_ensure_integration_branch_commands({
      integrationBranch: "auto/gits-self",
      baseRef: "gits",
    });
    expect(cmds.map((c) => c.args)).toEqual([
      ["fetch", "origin", "gits"],
      ["push", "origin", "refs/remotes/origin/gits:refs/heads/auto/gits-self"],
    ]);
  });

  it("fast-forwards the integration branch to the slice tip on origin", () => {
    const cmds = build_land_slice_commands({
      sliceBranch: "codex-peer/peer-1",
      integrationBranch: "auto/gits-self",
    });
    expect(cmds.map((c) => c.args)).toEqual([
      ["fetch", "origin", "codex-peer/peer-1"],
      ["push", "origin", "refs/remotes/origin/codex-peer/peer-1:refs/heads/auto/gits-self"],
    ]);
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type OrchestrationReadModel, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ensureLiveProjectForWorkspaceRoot } from "./open.ts";
import { type ProjectCliDispatchCommand } from "./liveServer.ts";

const emptySnapshot: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const snapshotWithProject = (workspaceRoot: string): OrchestrationReadModel => ({
  ...emptySnapshot,
  projects: [
    {
      id: ProjectId.make("11111111-1111-4111-8111-111111111111"),
      title: "existing",
      workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      deletedAt: null,
    },
  ],
});

it.layer(NodeServices.layer)("open ensureLiveProjectForWorkspaceRoot", (it) => {
  it.effect("reuses an existing project for the workspace root without dispatching", () =>
    Effect.gen(function* () {
      const dispatched: ProjectCliDispatchCommand[] = [];
      const message = yield* ensureLiveProjectForWorkspaceRoot(
        snapshotWithProject("/tmp/workspace"),
        "/tmp/workspace",
        (command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }),
      );

      assert.equal(dispatched.length, 0);
      assert.match(message, /Opened project 11111111-1111-4111-8111-111111111111 \(existing\)/);
    }),
  );

  it.effect("creates a project.create command when none exists for the workspace root", () =>
    Effect.gen(function* () {
      const dispatched: ProjectCliDispatchCommand[] = [];
      const message = yield* ensureLiveProjectForWorkspaceRoot(
        emptySnapshot,
        "/tmp/new-workspace",
        (command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }),
      );

      assert.equal(dispatched.length, 1);
      const command = dispatched[0];
      assert.ok(command);
      assert.equal(command.type, "project.create");
      if (command.type === "project.create") {
        assert.equal(command.workspaceRoot, "/tmp/new-workspace");
        assert.equal(command.title, "new-workspace");
      }
      assert.match(message, /Opened project .+ \(new-workspace\) at \/tmp\/new-workspace\./);
    }),
  );
});

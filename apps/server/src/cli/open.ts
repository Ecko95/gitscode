/**
 * `t3 open <path>` — open a directory in the running app, starting the server
 * rooted at the directory when nothing is running.
 *
 * When a live server is detected this adds (or reuses) a project for the path
 * and surfaces the app by opening its origin in the browser. When no server is
 * running it delegates to {@link runServerCommand} with
 * `forceAutoBootstrapProjectFromCwd`, reusing the existing auto-bootstrap +
 * browser-open startup path so the project is created and the app opens.
 *
 * @module cli/open
 */
import { CommandId, OrchestrationReadModel, ProjectId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { Command, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { AuthControlPlaneRuntimeLive } from "../auth/Layers/AuthControlPlane.ts";
import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { ServerConfig } from "../config.ts";
import { launchBrowser } from "../process/externalLauncher.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./config.ts";
import {
  dispatchLiveOrchestrationCommand,
  fetchLiveOrchestrationSnapshot,
  ProjectCommandError,
  tryResolveLiveProjectExecutionMode,
  withProjectCliSessionToken,
  type ProjectCliDispatchCommand,
} from "./liveServer.ts";
import { runServerCommand } from "./server.ts";

const openCommandUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(
    () =>
      new ProjectCommandError({
        message: "Failed to generate a project command identifier.",
      }),
  ),
);

const resolveProjectTitleFromPath = Effect.fn("resolveProjectTitleFromPath")(function* (
  workspaceRoot: string,
) {
  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

/**
 * Reuse an existing project for `workspaceRoot`, or create one via `dispatch`.
 * Exported for unit testing the open happy-path without a live server.
 */
export const ensureLiveProjectForWorkspaceRoot = Effect.fn("ensureLiveProjectForWorkspaceRoot")(
  function* <R>(
    snapshot: OrchestrationReadModel,
    workspaceRoot: string,
    dispatch: (command: ProjectCliDispatchCommand) => Effect.Effect<void, Error, R>,
  ) {
    const existingProject = snapshot.projects.find(
      (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
    );
    if (existingProject) {
      return `Opened project ${existingProject.id} (${existingProject.title}) at ${workspaceRoot}.`;
    }

    const title = yield* resolveProjectTitleFromPath(workspaceRoot);
    const projectId = ProjectId.make(yield* openCommandUuid);
    yield* dispatch({
      type: "project.create",
      commandId: CommandId.make(yield* openCommandUuid),
      projectId,
      title,
      workspaceRoot,
      defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    return `Opened project ${projectId} (${title}) at ${workspaceRoot}.`;
  },
);

const openInLiveServer = Effect.fn("openInLiveServer")(function* (
  origin: string,
  workspaceRoot: string,
) {
  const authControlPlane = yield* AuthControlPlane;
  const message = yield* withProjectCliSessionToken(authControlPlane, (token) =>
    Effect.gen(function* () {
      const snapshot = yield* fetchLiveOrchestrationSnapshot(origin, token);
      return yield* ensureLiveProjectForWorkspaceRoot(snapshot, workspaceRoot, (command) =>
        dispatchLiveOrchestrationCommand(origin, token, command),
      );
    }),
  );

  yield* launchBrowser(origin).pipe(
    Effect.catch(() => Effect.logInfo("browser open unavailable", { hint: `Open ${origin}.` })),
  );
  yield* Console.log(`${message}\nOpen ${origin} to view it.`);
});

export const openCommand = Command.make("open", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Open a directory in the app, starting the server rooted there if it is not running.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel);
      const minimumLogLevel = config.logLevel;
      const workspaceRoot = config.cwd;

      const liveMode = yield* Effect.gen(function* () {
        const authControlPlane = yield* AuthControlPlane;
        return yield* tryResolveLiveProjectExecutionMode(authControlPlane, config);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(AuthControlPlaneRuntimeLive, WorkspacePathsLive).pipe(
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(ServerConfig, config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
          ),
        ),
      );

      if (Option.isSome(liveMode)) {
        return yield* openInLiveServer(liveMode.value.origin, workspaceRoot).pipe(
          Effect.provide(
            Layer.mergeAll(AuthControlPlaneRuntimeLive, WorkspacePathsLive).pipe(
              Layer.provideMerge(FetchHttpClient.layer),
              Layer.provide(Layer.succeed(ServerConfig, config)),
              Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
            ),
          ),
        );
      }

      return yield* runServerCommand(flags, { forceAutoBootstrapProjectFromCwd: true });
    }),
  ),
);

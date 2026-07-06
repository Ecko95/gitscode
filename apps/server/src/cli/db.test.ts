import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { assertServerNotRunning, getServerPidFilePath, SERVER_PID_FILE_NAME } from "./db.ts";

it.layer(NodeServices.layer)("db maintenance server guard", (it) => {
  it.effect("refuses when pidfile points at a live process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-db-guard-live-" });
      const dbPath = path.join(stateDir, "state.sqlite");
      const pidFilePath = getServerPidFilePath({ stateDir }, path);

      yield* fs.writeFileString(pidFilePath, `${process.pid}\n`);

      const exit = yield* assertServerNotRunning({ stateDir }, dbPath).pipe(Effect.exit);
      assert.ok(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const message = exit.cause.reasons
          .filter(Cause.isDieReason)
          .map((reason) => String(reason.defect))
          .join("\n");
        assert.ok(message.includes(`pid ${process.pid}`));
        assert.ok(message.includes(SERVER_PID_FILE_NAME));
      }
    }),
  );

  it.effect("allows stale pidfiles to fall through to the SQLite probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-db-guard-stale-" });
      const dbPath = path.join(stateDir, "state.sqlite");
      const pidFilePath = getServerPidFilePath({ stateDir }, path);

      yield* fs.writeFileString(pidFilePath, "2147483647\n");

      yield* assertServerNotRunning({ stateDir }, dbPath);
    }),
  );

  it.effect("allows missing pidfiles on first run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-db-guard-missing-" });
      const dbPath = path.join(stateDir, "state.sqlite");

      yield* assertServerNotRunning({ stateDir }, dbPath);
    }),
  );
});

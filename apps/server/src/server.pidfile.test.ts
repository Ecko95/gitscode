import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { removeServerPidFile, writeServerPidFile } from "./server.ts";

it.layer(NodeServices.layer)("server pidfile", (it) => {
  it.effect("writes current pid and removes it on release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-pidfile-" });

      const pidFilePath = yield* writeServerPidFile({ stateDir });
      assert.equal(yield* fs.readFileString(pidFilePath), `${process.pid}\n`);

      yield* removeServerPidFile(pidFilePath);
      assert.isFalse(yield* fs.exists(pidFilePath));
    }),
  );

  it.effect("does not remove a pidfile replaced by another process", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-pidfile-replaced-" });

      const pidFilePath = yield* writeServerPidFile({ stateDir });
      yield* fs.writeFileString(pidFilePath, "12345\n");

      yield* removeServerPidFile(pidFilePath);
      assert.equal(yield* fs.readFileString(pidFilePath), "12345\n");
    }),
  );
});

import type { RemoteAgentRecord } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { RemoteAgentRegistry, RemoteAgentRegistryLive } from "./RemoteAgentRegistry.ts";

const makeRecord = (overrides?: Partial<RemoteAgentRecord>): RemoteAgentRecord => ({
  id: "agent-1",
  alias: "example",
  target: { alias: "example", hostname: "example.com", username: "ada", port: null },
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
  remoteServerKind: "managed",
  createdAt: "2026-06-07T00:00:00.000Z",
  lastSeenAt: "2026-06-07T00:00:00.000Z",
  ...overrides,
});

const makeRegistryLayer = (baseDir: string) =>
  RemoteAgentRegistryLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

it.layer(NodeServices.layer)("RemoteAgentRegistry", (it) => {
  it.effect("round-trips records across registry instances", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-registry-test-" });
      const record = makeRecord();

      yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        yield* registry.upsert(record);
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      const reloaded = yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        return yield* registry.list();
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      assert.equal(reloaded.length, 1);
      expect(reloaded[0]).toEqual(record);
    }),
  );

  it.effect("persists under <state-dir>/remote-agents.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-registry-path-" });

      const config = yield* ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );

      yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        yield* registry.upsert(makeRecord());
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      assert.isTrue(config.remoteAgentsPath.endsWith("remote-agents.json"));
      assert.isTrue(yield* fs.exists(config.remoteAgentsPath));
    }),
  );

  it.effect("upsert replaces an existing record by alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-registry-upsert-" });

      const reloaded = yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        yield* registry.upsert(makeRecord({ httpBaseUrl: "http://127.0.0.1:3773" }));
        yield* registry.upsert(makeRecord({ httpBaseUrl: "http://127.0.0.1:4000" }));
        return yield* registry.list();
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      assert.equal(reloaded.length, 1);
      assert.equal(reloaded[0]?.httpBaseUrl, "http://127.0.0.1:4000");
    }),
  );

  it.effect("find resolves by id and by alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-registry-find-" });

      const result = yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        yield* registry.upsert(makeRecord());
        const byId = yield* registry.find("agent-1");
        const byAlias = yield* registry.find("example");
        const missing = yield* registry.find("nope");
        return { byId, byAlias, missing };
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      assert.equal(result.byId?.id, "agent-1");
      assert.equal(result.byAlias?.id, "agent-1");
      assert.equal(result.missing, null);
    }),
  );

  it.effect("remove is idempotent and reports whether a record was dropped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-registry-remove-" });

      const result = yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        yield* registry.upsert(makeRecord());
        const first = yield* registry.remove("example");
        const second = yield* registry.remove("example");
        const remaining = yield* registry.list();
        return { first, second, remaining };
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      assert.equal(result.first, true);
      assert.equal(result.second, false);
      assert.equal(result.remaining.length, 0);
    }),
  );

  it.effect("list returns an empty array when no registry file exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-remote-registry-empty-" });

      const agents = yield* Effect.gen(function* () {
        const registry = yield* RemoteAgentRegistry;
        return yield* registry.list();
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));

      assert.equal(agents.length, 0);
    }),
  );
});

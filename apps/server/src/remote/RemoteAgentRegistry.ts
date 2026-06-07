/**
 * RemoteAgentRegistry - Saved remote-agent registry.
 *
 * Persists the set of remote T3 agents provisioned over SSH from a headless
 * control plane as a small JSON file under the server state directory. Used by
 * the `t3 remote` CLI today; designed to be forward-compatible with a future
 * HTTP/WS surface for the web UI. Never stores pairing secrets.
 *
 * @module RemoteAgentRegistry
 */
import {
  REMOTE_AGENT_REGISTRY_VERSION,
  RemoteAgentRegistryFile,
  type RemoteAgentRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

export class RemoteAgentRegistryError extends Data.TaggedError("RemoteAgentRegistryError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const RemoteAgentRegistryFileJson = Schema.fromJsonString(RemoteAgentRegistryFile);
const decodeRemoteAgentRegistryFile = Schema.decodeUnknownEffect(RemoteAgentRegistryFileJson);
const encodeRemoteAgentRegistryFile = Schema.encodeEffect(RemoteAgentRegistryFileJson);

const EMPTY_REGISTRY: RemoteAgentRegistryFile = {
  version: REMOTE_AGENT_REGISTRY_VERSION,
  agents: [],
};

export interface RemoteAgentRegistryShape {
  readonly list: () => Effect.Effect<ReadonlyArray<RemoteAgentRecord>, RemoteAgentRegistryError>;
  readonly find: (
    identifier: string,
  ) => Effect.Effect<RemoteAgentRecord | null, RemoteAgentRegistryError>;
  readonly upsert: (record: RemoteAgentRecord) => Effect.Effect<void, RemoteAgentRegistryError>;
  readonly remove: (identifier: string) => Effect.Effect<boolean, RemoteAgentRegistryError>;
}

export class RemoteAgentRegistry extends Context.Service<
  RemoteAgentRegistry,
  RemoteAgentRegistryShape
>()("t3/remote/RemoteAgentRegistry") {}

const matchesIdentifier = (record: RemoteAgentRecord, identifier: string): boolean => {
  const trimmed = identifier.trim();
  return record.id === trimmed || record.alias === trimmed;
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const runtimeContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const filePath = config.remoteAgentsPath;

  const read = Effect.fn("remote.registry.read")(function* () {
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return EMPTY_REGISTRY;
    }
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return EMPTY_REGISTRY;
    }
    return yield* decodeRemoteAgentRegistryFile(trimmed).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteAgentRegistryError({
            message: `Failed to parse the remote-agent registry at ${filePath}.`,
            cause,
          }),
      ),
    );
  });

  const write = Effect.fn("remote.registry.write")(function* (file: RemoteAgentRegistryFile) {
    const contents = yield* encodeRemoteAgentRegistryFile(file).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteAgentRegistryError({
            message: "Failed to serialize the remote-agent registry.",
            cause,
          }),
      ),
    );
    yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteAgentRegistryError({
            message: `Failed to write the remote-agent registry at ${filePath}.`,
            cause,
          }),
      ),
      Effect.provide(runtimeContext),
    );
  });

  return RemoteAgentRegistry.of({
    list: () => read().pipe(Effect.map((file) => file.agents)),
    find: (identifier) =>
      read().pipe(
        Effect.map(
          (file) => file.agents.find((agent) => matchesIdentifier(agent, identifier)) ?? null,
        ),
      ),
    upsert: (record) =>
      Effect.gen(function* () {
        const file = yield* read();
        const agents = [
          ...file.agents.filter((agent) => agent.id !== record.id && agent.alias !== record.alias),
          record,
        ];
        yield* write({ version: REMOTE_AGENT_REGISTRY_VERSION, agents });
      }),
    remove: (identifier) =>
      Effect.gen(function* () {
        const file = yield* read();
        const agents = file.agents.filter((agent) => !matchesIdentifier(agent, identifier));
        if (agents.length === file.agents.length) {
          return false;
        }
        yield* write({ version: REMOTE_AGENT_REGISTRY_VERSION, agents });
        return true;
      }),
  });
});

export const RemoteAgentRegistryLive = Layer.effect(RemoteAgentRegistry, make);

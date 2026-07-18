import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderSessionRuntimeRepository } from "../Services/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProviderSessionRuntimeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProviderSessionRuntimeRepository", (it) => {
  it.effect("skips undecodable rows and returns the decodable ones", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const lastSeenAt = "2026-06-20T00:00:00.000Z";

      // Stale row from an older build: an unknown runtime_mode no longer decodes.
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${ThreadId.make("thread-corrupt")},
          ${"codex"},
          NULL,
          ${"codex"},
          ${"invalid-runtime-mode"},
          ${"running"},
          ${lastSeenAt},
          NULL,
          NULL
        )
      `;

      const validThreadId = ThreadId.make("thread-valid");
      yield* runtimes.upsert({
        threadId: validThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt,
        resumeCursor: null,
        runtimePayload: null,
      });

      const listed = yield* runtimes.list();
      assert.deepStrictEqual(
        listed.map((runtime) => runtime.threadId),
        [validThreadId],
      );
    }),
  );
});

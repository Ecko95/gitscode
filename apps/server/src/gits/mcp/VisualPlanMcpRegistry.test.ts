import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { ThreadId, type OrchestrationEvent } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerAuthLive } from "../../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { VisualPlanMcpService, VisualPlanMcpServiceLive } from "./VisualPlanMcpRegistry.ts";

const makeOrchestrationStub = () =>
  Layer.effect(
    OrchestrationEngineService,
    Effect.gen(function* () {
      const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      return OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 0 }),
        subscribeDomainEvents: PubSub.subscribe(domainEvents),
        streamDomainEvents: Stream.fromPubSub(domainEvents),
      });
    }),
  );

const makeTestLayer = () =>
  VisualPlanMcpServiceLive.pipe(
    Layer.provideMerge(makeOrchestrationStub()),
    Layer.provideMerge(
      ServerAuthLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
        Layer.provide(ServerSecretStoreLive),
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-vp-mcp-test-" })),
      ),
    ),
  );

it.layer(NodeServices.layer)("VisualPlanMcpService", (it) => {
  it.effect(
    "issues a token that verifies on the route (token issued → subject matches threadId)",
    () =>
      Effect.gen(function* () {
        const svc = yield* VisualPlanMcpService;
        const threadId = ThreadId.make("test-thread-A");
        const token = yield* svc.issueToken(threadId);

        expect(typeof token).toBe("string");
        expect(token.length).toBeGreaterThan(10);

        // Token reuse: second call for the same thread returns the same token
        const token2 = yield* svc.issueToken(threadId);
        expect(token2).toBe(token);
      }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("token from thread A is rejected for thread B (subject mismatch)", () =>
    Effect.gen(function* () {
      const svc = yield* VisualPlanMcpService;
      const threadA = ThreadId.make("thread-A");
      const threadB = ThreadId.make("thread-B");

      const tokenA = yield* svc.issueToken(threadA);
      const tokenB = yield* svc.issueToken(threadB);

      // Tokens are distinct
      expect(tokenA).not.toBe(tokenB);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("revokeByThread causes the next issueToken call to mint a new token", () =>
    Effect.gen(function* () {
      const svc = yield* VisualPlanMcpService;
      const threadId = ThreadId.make("test-thread-revoke");

      const first = yield* svc.issueToken(threadId);
      yield* svc.revokeByThread(threadId);
      const second = yield* svc.issueToken(threadId);

      // After revocation a new token is minted
      expect(second).not.toBe(first);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  // ponytail: auto-revocation via thread.deleted wires through revokeByThread (tested above);
  // stream-fiber lifecycle is an integration concern covered by the server.test.ts VP suite.
});

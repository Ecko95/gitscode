// SP3 — delamain → T3 orchestration bridge ingress.
//
// One additive, owner-gated route that lets the delamain t3Bridge dispatch
// orchestration commands as actor "server" — specifically thread.create (to
// mirror a delamain workflow as a thread) and thread.activity.append (the
// per-event log rows that render in the existing thread detail /
// SubagentTaskSurface). Neither is in ClientOrchestrationCommand, so the
// operator-actor /api/orchestration/dispatch route cannot carry them; this
// route accepts the full OrchestrationCommand union and stamps "server"
// (authorized for structural + provider commands, commandInvariants.ts).

import { OrchestrationCommand, OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import {
  authenticateOwnerSession,
  respondToOrchestrationHttpError,
} from "../orchestration/http.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

const delamainIngestHandler = Effect.gen(function* () {
  yield* authenticateOwnerSession;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const command = yield* HttpServerRequest.schemaBodyJson(OrchestrationCommand).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationDispatchCommandError({
          message: "Invalid delamain ingest command payload.",
          cause,
        }),
    ),
  );
  const result = yield* startup
    .enqueueCommand(orchestrationEngine.dispatch(command, "server"))
    .pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message: "Failed to dispatch delamain ingest command.",
            cause,
          }),
      ),
    );
  return HttpServerResponse.jsonUnsafe(result, { status: 200 });
}).pipe(
  Effect.catchTags({
    AuthError: respondToAuthError,
    OrchestrationDispatchCommandError: respondToOrchestrationHttpError,
  }),
);

export const delamainIngestRouteLayer = HttpRouter.add(
  "POST",
  "/api/delamain/ingest",
  delamainIngestHandler,
);

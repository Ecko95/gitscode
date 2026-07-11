/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationActorKind,
  OrchestrationCommand,
  OrchestrationEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { SessionRole } from "../../auth/Services/SessionCredentialService.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @param actor - Identity of the actor dispatching the command (stamped server-side).
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    actor: OrchestrationActorKind,
    sessionRole?: SessionRole,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Acquire a domain-event subscription synchronously in the caller's scope.
   *
   * Startup and snapshot consumers should acquire this before announcing
   * readiness or reading a snapshot, then consume it with
   * `Stream.fromSubscription`. This avoids the lazy `Stream.fromPubSub`
   * subscription window where a hot event can be published before the
   * consumer fiber starts running.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    PubSub.Subscription<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   * Consumers that must be ready before returning should use
   * `subscribeDomainEvents` instead.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}

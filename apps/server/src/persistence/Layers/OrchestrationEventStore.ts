import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  ProjectId,
  ThreadId,
  WorktreePath,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId, WorktreePath]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, WorktreePath]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const append: OrchestrationEventStoreShape["append"] = (event, actorKind) =>
    appendEventRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      // ponytail: stamped actor takes precedence; inferActorKind is fallback for pre-actor replay events
      actorKind: actorKind ?? inferActorKind(event),
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: event.payload,
      metadataJson: event.metadata,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodeEvent(row).pipe(
          Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
        ),
      ),
    );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  const readAllEventRowsFromUnion = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OrchestrationEventPersistedRowSchema,
    execute: () =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        UNION ALL
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events_archive
        ORDER BY sequence ASC
      `,
  });

  const readAllWithArchive: OrchestrationEventStoreShape["readAllWithArchive"] = () =>
    Stream.fromEffect(
      readAllEventRowsFromUnion(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.readAllWithArchive:query",
            "OrchestrationEventStore.readAllWithArchive:decodeRows",
          ),
        ),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeEvent(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("OrchestrationEventStore.readAllWithArchive:rowToEvent"),
              ),
            ),
          ),
        ),
      ),
    ).pipe(Stream.flatMap(Stream.fromIterable));

  const archiveEligibleEvents: OrchestrationEventStoreShape["archiveEligibleEvents"] = (
    retentionDays,
  ) =>
    Effect.gen(function* () {
      if (retentionDays <= 0) {
        return 0;
      }

      // Find eligible stream_ids: thread-scoped, fully deleted, past retention window,
      // no in-flight worktree.retiring-started without a matching worktree.buried.
      const eligible = yield* sql<{ readonly stream_id: string }>`
        SELECT e.stream_id
        FROM orchestration_events e
        INNER JOIN projection_threads t ON t.thread_id = e.stream_id
        WHERE t.deleted_at IS NOT NULL
          AND t.deleted_at < datetime('now', ${`-${retentionDays} days`})
          AND e.aggregate_kind = 'thread'
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events g
            WHERE g.stream_id = e.stream_id
              AND g.event_type = 'worktree.retiring-started'
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_events b
                WHERE b.stream_id = g.stream_id
                  AND b.event_type = 'worktree.buried'
              )
          )
        GROUP BY e.stream_id
      `.pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventStore.archiveEligibleEvents:findEligible"),
        ),
      );

      if (eligible.length === 0) {
        return 0;
      }

      const streamIds = eligible.map((r) => r.stream_id);

      // Atomic move: INSERT ... SELECT then DELETE, one stream at a time to avoid
      // complex IN-clause generation across dialects.
      // ponytail: loop over streamIds — N is bounded by eligible closed threads per run;
      // in practice single-digit on a normal instance. Upgrade to bulk IN if needed.
      let totalArchived = 0;
      for (const streamId of streamIds) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const countBefore = yield* sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${streamId}
            `.pipe(
                Effect.mapError(
                  toPersistenceSqlError(
                    "OrchestrationEventStore.archiveEligibleEvents:countBefore",
                  ),
                ),
              );
              const n = countBefore[0]?.n ?? 0;
              if (n === 0) return;

              yield* sql`
              INSERT INTO orchestration_events_archive
              SELECT * FROM orchestration_events WHERE stream_id = ${streamId}
            `.pipe(
                Effect.mapError(
                  toPersistenceSqlError("OrchestrationEventStore.archiveEligibleEvents:insert"),
                ),
              );
              yield* sql`
              DELETE FROM orchestration_events WHERE stream_id = ${streamId}
            `.pipe(
                Effect.mapError(
                  toPersistenceSqlError("OrchestrationEventStore.archiveEligibleEvents:delete"),
                ),
              );
              totalArchived += n;
            }),
          )
          .pipe(
            Effect.mapError(
              toPersistenceSqlError("OrchestrationEventStore.archiveEligibleEvents:transaction"),
            ),
          );
      }

      return totalArchived;
    });

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    readAllWithArchive,
    archiveEligibleEvents,
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);

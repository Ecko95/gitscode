import { WebPushSubscription } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type WebPushSubscriptionRepositoryError,
} from "../Errors.ts";
import {
  WebPushSubscriptionRepository,
  type PersistedWebPushSubscription,
  type WebPushSubscriptionRepositoryShape,
} from "../Services/WebPushSubscriptions.ts";

const WebPushSubscriptionDbRow = Schema.Struct({
  endpoint: Schema.String,
  subscription: Schema.fromJsonString(WebPushSubscription),
  userAgent: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type WebPushSubscriptionDbRow = typeof WebPushSubscriptionDbRow.Type;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): WebPushSubscriptionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeWebPushSubscriptionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: Schema.Struct({
      endpoint: Schema.String,
      subscription: Schema.fromJsonString(WebPushSubscription),
      userAgent: Schema.NullOr(Schema.String),
      now: Schema.String,
    }),
    execute: (row) =>
      sql`
        INSERT INTO web_push_subscriptions (
          endpoint,
          subscription_json,
          user_agent,
          created_at,
          updated_at
        )
        VALUES (
          ${row.endpoint},
          ${row.subscription},
          ${row.userAgent},
          ${row.now},
          ${row.now}
        )
        ON CONFLICT(endpoint) DO UPDATE SET
          subscription_json = excluded.subscription_json,
          user_agent = excluded.user_agent,
          updated_at = excluded.updated_at
      `,
  });

  const deleteByEndpointRow = SqlSchema.void({
    Request: Schema.Struct({ endpoint: Schema.String }),
    execute: ({ endpoint }) =>
      sql`
        DELETE FROM web_push_subscriptions
        WHERE endpoint = ${endpoint}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WebPushSubscriptionDbRow,
    execute: () =>
      sql`
        SELECT
          endpoint,
          subscription_json AS "subscription",
          user_agent AS "userAgent",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM web_push_subscriptions
        ORDER BY updated_at DESC, endpoint ASC
      `,
  });

  const upsert: WebPushSubscriptionRepositoryShape["upsert"] = (input) =>
    upsertRow({
      endpoint: input.subscription.endpoint,
      subscription: input.subscription,
      userAgent: input.userAgent,
      now: input.now,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.upsert:query",
          "WebPushSubscriptionRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteByEndpoint: WebPushSubscriptionRepositoryShape["deleteByEndpoint"] = (endpoint) =>
    deleteByEndpointRow({ endpoint }).pipe(
      Effect.mapError(toPersistenceSqlError("WebPushSubscriptionRepository.deleteByEndpoint")),
    );

  const list: WebPushSubscriptionRepositoryShape["list"] = () =>
    listRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "WebPushSubscriptionRepository.list:query",
          "WebPushSubscriptionRepository.list:decodeRows",
        ),
      ),
      Effect.map(
        (rows): ReadonlyArray<PersistedWebPushSubscription> =>
          rows.map((row) => ({
            subscription: row.subscription,
            userAgent: row.userAgent,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
      ),
    );

  return { upsert, deleteByEndpoint, list } satisfies WebPushSubscriptionRepositoryShape;
});

export const WebPushSubscriptionRepositoryLive = Layer.effect(
  WebPushSubscriptionRepository,
  makeWebPushSubscriptionRepository,
);

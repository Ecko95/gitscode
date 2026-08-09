import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CockpitInboxError,
  CockpitInboxItem,
  type CockpitInboxFilter,
  type CockpitInboxListResult,
  type CockpitInboxState,
} from "@t3tools/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  CockpitInbox,
  type CockpitInboxRecordInput,
  type CockpitInboxRecordResult,
} from "../Services/CockpitInbox.ts";

const STATE_FILE = "cockpit-inbox.json";
const RETENTION_MS = 90 * 86_400_000;
const TERMINAL_STATES = new Set<CockpitInboxState>(["completed", "rejected", "deferred"]);

const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(CockpitInboxItem),
});
type PersistedState = typeof PersistedState.Type;

const decodePersistedState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedState));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

interface InboxState {
  readonly items: ReadonlyArray<CockpitInboxItem>;
  readonly loadError: string | null;
}

function toInboxError(message: string, cause?: unknown) {
  return new CockpitInboxError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isUnread(item: CockpitInboxItem): boolean {
  return item.readAt === null || Date.parse(item.readAt) < Date.parse(item.updatedAt);
}

function matches(item: CockpitInboxItem, filter: CockpitInboxFilter | undefined): boolean {
  switch (filter) {
    case undefined:
      return true;
    case "unread":
      return isUnread(item);
    case "pending":
      return item.state === "pending-review";
    case "approved":
      return ["approved-queued", "scheduled-tonight", "running"].includes(item.state);
    case "waiting":
      return ["waiting-quota-reset", "attention-required"].includes(item.state);
    case "completed":
      return TERMINAL_STATES.has(item.state);
  }
}

function prune(items: ReadonlyArray<CockpitInboxItem>, nowMs: number) {
  return items.filter(
    (item) =>
      item.pinned || item.terminalAt === null || nowMs - Date.parse(item.terminalAt) < RETENTION_MS,
  );
}

function result(items: ReadonlyArray<CockpitInboxItem>, filter?: CockpitInboxFilter) {
  const sorted = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    items: sorted.filter((item) => matches(item, filter)),
    counts: {
      unread: sorted.filter((item) => matches(item, "unread")).length,
      pending: sorted.filter((item) => matches(item, "pending")).length,
      approved: sorted.filter((item) => matches(item, "approved")).length,
      waiting: sorted.filter((item) => matches(item, "waiting")).length,
      completed: sorted.filter((item) => matches(item, "completed")).length,
    },
  } satisfies CockpitInboxListResult;
}

function persist(filePath: string, items: ReadonlyArray<CockpitInboxItem>) {
  return writeFileStringAtomically({
    filePath,
    contents: `${JSON.stringify({ version: 1, items } satisfies PersistedState, null, 2)}\n`,
  }).pipe(Effect.mapError((cause) => toInboxError("Failed to persist Cockpit Inbox.", cause)));
}

export const CockpitInboxLive = Layer.effect(
  CockpitInbox,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(config.stateDir, "gits", STATE_FILE);
    const loaded = yield* Effect.gen(function* () {
      const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return { items: [], loadError: null } satisfies InboxState;
      const decoded = yield* fs
        .readFileString(filePath)
        .pipe(Effect.flatMap(decodePersistedState), Effect.result);
      if (decoded._tag === "Success") {
        return {
          items: decoded.success.items,
          loadError: null,
        } satisfies InboxState;
      }
      yield* Effect.logWarning("gits.cockpit-inbox.load-failed", {
        path: filePath,
        cause: String(decoded.failure),
      });
      return {
        items: [],
        loadError: "Cockpit Inbox is unavailable because its state file is invalid.",
      } satisfies InboxState;
    });
    const initialNow = DateTime.toEpochMillis(yield* DateTime.now);
    const stateRef = yield* Ref.make<InboxState>({
      ...loaded,
      items: prune(loaded.items, initialNow),
    });
    const semaphore = yield* Semaphore.make(1);

    const writable = (state: InboxState) =>
      state.loadError === null ? Effect.void : Effect.fail(toInboxError(state.loadError));

    const commit = <A>(
      update: (
        state: InboxState,
        at: string,
      ) => Effect.Effect<readonly [InboxState, A], CockpitInboxError>,
    ): Effect.Effect<A, CockpitInboxError> =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          yield* writable(state);
          const at = yield* nowIso;
          const [next, value] = yield* update(state, at);
          const pruned = {
            ...next,
            items: prune(next.items, Date.parse(at)),
          } satisfies InboxState;
          yield* persist(filePath, pruned.items).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          yield* Ref.set(stateRef, pruned);
          return value;
        }),
      );

    const list = (filter?: CockpitInboxFilter) =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((state) => writable(state).pipe(Effect.as(result(state.items, filter)))),
      );

    return {
      record: (input: CockpitInboxRecordInput) =>
        semaphore.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* Ref.get(stateRef);
            yield* writable(state);
            const existing = state.items.find((item) => item.id === input.episodeId);
            const priorEvent = existing?.timeline.find((item) => item.eventKey === input.eventKey);
            if (existing !== undefined && priorEvent !== undefined) {
              return {
                item: existing,
                event: priorEvent,
                created: false,
              } satisfies CockpitInboxRecordResult;
            }
            const at = yield* nowIso;
            const event = {
              eventKey: input.eventKey,
              at,
              state: input.state,
              reason: input.reason,
              deepLink: input.deepLink,
            } as const;
            const item: CockpitInboxItem = {
              id: input.episodeId,
              proposalId: existing?.proposalId ?? input.proposalId,
              goalId: input.goalId ?? existing?.goalId ?? null,
              title: input.title,
              repository: input.repository,
              state: input.state,
              createdAt: existing?.createdAt ?? at,
              updatedAt: at,
              terminalAt: TERMINAL_STATES.has(input.state) ? at : null,
              readAt: null,
              pinned: existing?.pinned ?? false,
              reason: input.reason,
              deepLink: input.deepLink,
              timeline: [...(existing?.timeline ?? []), event],
            };
            const nextItems = [
              item,
              ...state.items.filter((candidate) => candidate.id !== item.id),
            ];
            const pruned = prune(nextItems, Date.parse(at));
            yield* persist(filePath, pruned).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            yield* Ref.set(stateRef, { items: pruned, loadError: null });
            return {
              item,
              event,
              created: true,
            } satisfies CockpitInboxRecordResult;
          }),
        ),
      list: (input) => list(input.filter),
      markRead: (input) =>
        commit((state, at) =>
          Effect.gen(function* () {
            const item = state.items.find((candidate) => candidate.id === input.id);
            if (item === undefined) {
              return yield* toInboxError(`Cockpit Inbox item ${input.id} was not found.`);
            }
            const updated = { ...item, readAt: at };
            return [
              {
                ...state,
                items: state.items.map((candidate) =>
                  candidate.id === input.id ? updated : candidate,
                ),
              },
              updated,
            ] as const;
          }),
        ),
      markAllRead: (input) =>
        commit((state, at) =>
          Effect.sync(() => {
            const items = state.items.map((item) =>
              matches(item, input.filter) ? { ...item, readAt: at } : item,
            );
            return [{ ...state, items }, result(items, input.filter)] as const;
          }),
        ),
      setPinned: (input) =>
        commit((state) =>
          Effect.gen(function* () {
            const item = state.items.find((candidate) => candidate.id === input.id);
            if (item === undefined) {
              return yield* toInboxError(`Cockpit Inbox item ${input.id} was not found.`);
            }
            const updated = { ...item, pinned: input.pinned };
            return [
              {
                ...state,
                items: state.items.map((candidate) =>
                  candidate.id === input.id ? updated : candidate,
                ),
              },
              updated,
            ] as const;
          }),
        ),
    };
  }),
);

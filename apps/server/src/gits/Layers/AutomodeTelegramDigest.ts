import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { shortGoalCode } from "../HermesTelegramCommand.ts";
import { ServerConfig } from "../../config.ts";
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeTelegramDigest } from "../Services/AutomodeTelegramDigest.ts";
import { GitsSlotScheduler } from "../Services/GitsSlotScheduler.ts";
import { HermesTelegramNotifier } from "../Services/HermesTelegramNotifier.ts";
import { london_instant } from "./GitsSlotScheduler.ts";

const REPLY_HINT = "Reply: APPROVE <code> · REJECT <code>";

const STATE_FILE_NAME = "automode-telegram-digest-state.json";
const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  lastDigestDate: Schema.NullOr(Schema.String),
  lastMorningReportDate: Schema.NullOr(Schema.String),
});
type PersistedState = typeof PersistedState.Type;
const decodePersistedState = Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedState));

class AutomodeTelegramDigestStateError extends Schema.TaggedErrorClass<AutomodeTelegramDigestStateError>()(
  "AutomodeTelegramDigestStateError",
  { message: Schema.String },
) {}

const emptyState: PersistedState = {
  version: 1,
  lastDigestDate: null,
  lastMorningReportDate: null,
};

function loadState(statePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(statePath);
    if (!exists) return emptyState;
    const raw = yield* fs.readFileString(statePath);
    if (raw.trim() === "") {
      return yield* Effect.fail(
        new AutomodeTelegramDigestStateError({ message: "Telegram digest state is empty." }),
      );
    }
    return yield* decodePersistedState(raw).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("gits.telegram.state-invalid", { cause: Cause.pretty(cause) }).pipe(
          Effect.andThen(
            Effect.fail(
              new AutomodeTelegramDigestStateError({
                message: "Telegram digest state is invalid.",
              }),
            ),
          ),
        ),
      ),
    );
  });
}

function persistState(statePath: string, state: PersistedState) {
  return writeFileStringAtomically({
    filePath: statePath,
    contents: `${JSON.stringify(state, null, 2)}\n`,
  });
}

function terminalOutcomes(
  goals: ReadonlyArray<{ readonly title: string; readonly status: string }>,
) {
  const outcomes = goals.filter((goal) =>
    ["completed", "failed", "blocked", "rejected"].includes(goal.status),
  );
  return outcomes.length === 0
    ? "none"
    : outcomes.map((goal) => `- ${goal.title}: ${goal.status}`).join("\n");
}

export const AutomodeTelegramDigestLive = Layer.effect(
  AutomodeTelegramDigest,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const supervisor = yield* AutomodeSupervisor;
    const scheduler = yield* GitsSlotScheduler;
    const ledger = yield* AutomodeEpisodeLedger;
    const notifier = yield* HermesTelegramNotifier;
    const statePath = path.join(config.stateDir, "gits", STATE_FILE_NAME);
    const stateRef = yield* Ref.make(yield* loadState(statePath));
    const semaphore = yield* Semaphore.make(1);

    const tick = () =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const now = london_instant(yield* Clock.currentTimeMillis);
          const state = yield* Ref.get(stateRef);
          // Owner kill-switch: skip both reports outright, before any read/send, when off.
          const policy = yield* supervisor.getPolicy();
          if (!policy.telegramDigestEnabled) return;
          const morningDue =
            now.minutesOfDay >= 10 * 60 && state.lastMorningReportDate !== now.dateKey;
          const digestDue = now.minutesOfDay >= 22 * 60 && state.lastDigestDate !== now.dateKey;
          if (!morningDue && !digestDue) return;

          const snapshot = yield* supervisor.getSnapshot();
          const schedulerSnapshot = yield* scheduler.getSnapshot();
          const episodes = yield* ledger.list_episodes({ limit: 5 });
          const terminal = terminalOutcomes(snapshot.goals);

          const deliver = (subject: string, text: string) =>
            notifier.notify({ subject, text }).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("gits.telegram.delivery-failed", {
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
              ),
            );

          let next = state;
          if (morningDue) {
            const delivered = yield* deliver(
              "GITS morning report",
              [
                `Held PR: ${snapshot.heldPrUrl ?? "none"}`,
                `Terminal outcomes:\n${terminal}`,
                `Scheduler goal count: ${schedulerSnapshot.goalsStartedTonight}`,
                `Recent ledger outcomes: ${episodes.map((episode) => `${episode.goalTitle}: ${episode.verdict}`).join(", ") || "none"}`,
              ].join("\n\n"),
            );
            if (delivered) next = { ...next, lastMorningReportDate: now.dateKey };
          }
          if (digestDue) {
            const delivered = yield* deliver(
              "GITS evening digest",
              [
                "Queued/proposed goals:",
                ...snapshot.goals
                  // blocked included: goals parked by the kill switch / gates are exactly
                  // the ones the operator needs to see and can APPROVE.
                  .filter(
                    (goal) =>
                      goal.status === "queued" ||
                      goal.status === "waiting-approval" ||
                      goal.status === "blocked",
                  )
                  .slice(0, 5)
                  .map((goal) => `- ${goal.title} [${shortGoalCode(goal.id)}]`),
                "",
                REPLY_HINT,
              ].join("\n"),
            );
            if (delivered) next = { ...next, lastDigestDate: now.dateKey };
          }
          if (next !== state) {
            yield* persistState(statePath, next).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            yield* Ref.set(stateRef, next);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("gits.telegram.digest-failed", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );

    return { tick };
  }),
);

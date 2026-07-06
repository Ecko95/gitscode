import {
  EventId,
  MessageId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type WorktreePath,
} from "@t3tools/contracts";

const SERVER_AGGREGATE_ID = ProjectId.make("server");
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireThreadNotDeleted,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import {
  findThreadForkPrefix,
  inferThreadProviderLabel,
  resolveThreadForkAnchor,
  supportsFullThreadFork,
} from "./threadFork.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

function commandInvariantError(
  commandType: OrchestrationCommand["type"],
  detail: string,
): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

function forkCopyMessageId(input: {
  readonly threadId: Extract<OrchestrationCommand, { type: "thread.fork" }>["newThreadId"];
  readonly uuid: string;
}): MessageId {
  return MessageId.make(`${input.threadId}:fork-message:${input.uuid}`);
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.fork": {
      const sourceThread = yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.newThreadId,
      });

      if (command.mode === "full") {
        if (!supportsFullThreadFork(sourceThread)) {
          return yield* commandInvariantError(
            command.type,
            `thread-fork-provider-unsupported: fork is not supported for provider '${inferThreadProviderLabel(
              sourceThread,
            )}' yet.`,
          );
        }

        const anchorResolution = resolveThreadForkAnchor({
          sourceThread,
          messageId: command.messageId,
        });
        if (anchorResolution._tag === "missing-message") {
          return yield* commandInvariantError(
            command.type,
            `thread-fork-message-not-found: Message '${command.messageId}' does not belong to thread '${command.threadId}'.`,
          );
        }
        if (anchorResolution._tag === "unavailable") {
          return yield* commandInvariantError(
            command.type,
            `thread-fork-anchor-unavailable: Message '${command.messageId}' cannot be used as a fork anchor because no provider message id is available before it.`,
          );
        }
      }

      const prefixMessages = findThreadForkPrefix({
        sourceThread,
        messageId: command.messageId,
      });
      if (prefixMessages === undefined) {
        return yield* commandInvariantError(
          command.type,
          `thread-fork-message-not-found: Message '${command.messageId}' does not belong to thread '${command.threadId}'.`,
        );
      }

      const createdEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.newThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.newThreadId,
          projectId: sourceThread.projectId,
          title: `${sourceThread.title} (fork)`,
          modelSelection: sourceThread.modelSelection,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      const seedPrompt = command.mode === "summary" ? command.seedPrompt?.trim() : undefined;

      // ponytail: slice 2 copies message text only. Turn/checkpoint/file-state
      // copying is deliberately out of scope; slices 4/5 rely on this ceiling.
      const messageEvents: PlannedOrchestrationEvent[] = [];
      if (command.mode === "full") {
        for (const sourceMessage of prefixMessages) {
          const uuid = yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
          messageEvents.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: command.newThreadId,
              occurredAt: sourceMessage.createdAt,
              commandId: command.commandId,
            })),
            type: "thread.message-sent",
            payload: {
              threadId: command.newThreadId,
              messageId: forkCopyMessageId({
                threadId: command.newThreadId,
                uuid,
              }),
              role: sourceMessage.role,
              text: sourceMessage.text,
              ...(sourceMessage.attachments !== undefined
                ? { attachments: sourceMessage.attachments }
                : {}),
              ...(sourceMessage.providerMessageId !== undefined
                ? { providerMessageId: sourceMessage.providerMessageId }
                : {}),
              turnId: null,
              streaming: false,
              createdAt: sourceMessage.createdAt,
              updatedAt: sourceMessage.updatedAt,
            },
          });
        }
      }

      const forkedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.newThreadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.forked",
        payload: {
          sourceThreadId: command.threadId,
          forkMessageId: command.messageId,
          mode: command.mode,
          ...(seedPrompt ? { seedPrompt } : {}),
        },
      };

      return [createdEvent, ...messageEvents, forkedEvent];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThreadNotDeleted({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          ...(command.providerMessageId !== undefined
            ? { providerMessageId: command.providerMessageId }
            : {}),
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.visual-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.visual-plan-upserted",
        payload: {
          threadId: command.threadId,
          visualPlan: command.visualPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "worktree.retire.start": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreePath as WorktreePath,
          occurredAt: command.initiatedAt,
          commandId: command.commandId,
        })),
        type: "worktree.retiring-started",
        payload: {
          threadId: command.threadId,
          worktreePath: command.worktreePath,
          branch: command.branch,
          trigger: command.trigger,
          initiatedAt: command.initiatedAt,
        },
      };
    }

    case "worktree.bury": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreePath as WorktreePath,
          occurredAt: command.buriedAt,
          commandId: command.commandId,
        })),
        type: "worktree.buried",
        payload: {
          threadId: command.threadId,
          worktreePath: command.worktreePath,
          branch: command.branch,
          trigger: command.trigger,
          finalCheckpointRef: command.finalCheckpointRef,
          buriedAt: command.buriedAt,
        },
      };
    }

    case "worktree.record-owner": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreePath as WorktreePath,
          occurredAt: command.recordedAt,
          commandId: command.commandId,
        })),
        type: "worktree.owner-recorded",
        payload: {
          threadId: command.threadId,
          worktreePath: command.worktreePath,
          branch: command.branch,
          projectId: command.projectId,
          recordedAt: command.recordedAt,
        },
      };
    }

    case "worktree.adopt": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreePath as WorktreePath,
          occurredAt: command.adoptedAt,
          commandId: command.commandId,
        })),
        type: "worktree.adopted",
        payload: {
          worktreePath: command.worktreePath,
          branch: command.branch,
          orphanReason: "no-event-binding" as const,
          adoptedAt: command.adoptedAt,
        },
      };
    }

    // W5.4b audit commands — no invariant checks, pass-through to event store
    case "provider.session.spawn": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.spawnedAt,
          commandId: command.commandId,
        })),
        type: "provider.session.spawned",
        payload: {
          threadId: command.threadId,
          providerId: command.providerId,
          sessionId: command.sessionId,
          spawnedAt: command.spawnedAt,
        },
      };
    }

    case "provider.session.stop": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.stoppedAt,
          commandId: command.commandId,
        })),
        type: "provider.session.stopped",
        payload: {
          threadId: command.threadId,
          providerId: command.providerId,
          sessionId: command.sessionId,
          stoppedAt: command.stoppedAt,
        },
      };
    }

    case "auth.session.issue": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: SERVER_AGGREGATE_ID,
          occurredAt: command.issuedAt,
          commandId: command.commandId,
        })),
        type: "auth.session.issued",
        payload: {
          sessionId: command.sessionId,
          method: command.method,
          role: command.role,
          subject: command.subject,
          issuedAt: command.issuedAt,
        },
      };
    }

    case "auth.session.revoke": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: SERVER_AGGREGATE_ID,
          occurredAt: command.revokedAt,
          commandId: command.commandId,
        })),
        type: "auth.session.revoked",
        payload: {
          sessionId: command.sessionId,
          revokedAt: command.revokedAt,
        },
      };
    }

    case "auth.pairing-link.issue": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: SERVER_AGGREGATE_ID,
          occurredAt: command.issuedAt,
          commandId: command.commandId,
        })),
        type: "auth.pairing-link.issued",
        payload: {
          linkId: command.linkId,
          role: command.role,
          subject: command.subject,
          issuedAt: command.issuedAt,
        },
      };
    }

    case "auth.pairing-link.revoke": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: SERVER_AGGREGATE_ID,
          occurredAt: command.revokedAt,
          commandId: command.commandId,
        })),
        type: "auth.pairing-link.revoked",
        payload: {
          linkId: command.linkId,
          revokedAt: command.revokedAt,
        },
      };
    }

    case "settings.record-change": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: SERVER_AGGREGATE_ID,
          occurredAt: command.changedAt,
          commandId: command.commandId,
        })),
        type: "settings.changed",
        payload: {
          changedKeys: command.changedKeys,
          changedAt: command.changedAt,
        },
      };
    }

    case "vcs.worktree.record-created": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreePath as WorktreePath,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "vcs.worktree.created",
        payload: {
          worktreePath: command.worktreePath,
          branch: command.branch,
          createdAt: command.createdAt,
        },
      };
    }

    case "vcs.worktree.record-removed": {
      return {
        ...(yield* withEventBase({
          aggregateKind: "worktree",
          aggregateId: command.worktreePath as WorktreePath,
          occurredAt: command.removedAt,
          commandId: command.commandId,
        })),
        type: "vcs.worktree.removed",
        payload: {
          worktreePath: command.worktreePath,
          removedAt: command.removedAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});

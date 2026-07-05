import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-fork");
const SOURCE_THREAD_ID = ThreadId.make("thread-source");
const NEW_THREAD_ID = ThreadId.make("thread-fork");

const asMessageId = (value: string): MessageId => MessageId.make(value);

function message(input: {
  readonly id: string;
  readonly role: OrchestrationMessage["role"];
  readonly text: string;
  readonly providerMessageId?: string;
  readonly createdAt?: string;
}): OrchestrationMessage {
  const createdAt = input.createdAt ?? NOW;
  return {
    id: asMessageId(input.id),
    role: input.role,
    text: input.text,
    turnId: null,
    streaming: false,
    ...(input.providerMessageId !== undefined
      ? { providerMessageId: input.providerMessageId }
      : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

function thread(input?: {
  readonly providerInstanceId?: string;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
}): OrchestrationThread {
  const providerInstanceId = input?.providerInstanceId ?? "claudeAgent";
  return {
    id: SOURCE_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Source Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make(providerInstanceId),
      model: "claude-sonnet-4-6",
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: "feature/source",
    worktreePath: "/tmp/project-fork",
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    messages: [...(input?.messages ?? [])],
    proposedPlans: [],
    visualPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function readModel(sourceThread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project-fork",
        defaultModelSelection: sourceThread.modelSelection,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [sourceThread],
    updatedAt: NOW,
  };
}

function forkCommand(input: {
  readonly messageId: MessageId;
  readonly threadId?: ThreadId;
  readonly mode?: "full" | "summary";
}) {
  return {
    type: "thread.fork" as const,
    commandId: CommandId.make("cmd-thread-fork"),
    threadId: input.threadId ?? SOURCE_THREAD_ID,
    newThreadId: NEW_THREAD_ID,
    messageId: input.messageId,
    mode: input.mode ?? "full",
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("decider thread.fork", (it) => {
  it.effect("emits created, assistant-inclusive copied prefix, then forked", () =>
    Effect.gen(function* () {
      const sourceMessages = [
        message({ id: "message-user-1", role: "user", text: "first" }),
        message({
          id: "message-assistant-1",
          role: "assistant",
          text: "answer one",
          providerMessageId: "assistant-provider-1",
        }),
        message({ id: "message-user-2", role: "user", text: "second" }),
        message({
          id: "message-assistant-2",
          role: "assistant",
          text: "answer two",
          providerMessageId: "assistant-provider-2",
        }),
        message({ id: "message-user-3", role: "user", text: "after anchor" }),
      ];

      const result = yield* decideOrchestrationCommand({
        command: forkCommand({ messageId: asMessageId("message-assistant-2") }),
        readModel: readModel(thread({ messages: sourceMessages })),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.forked",
      ]);

      const created = events[0];
      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") {
        expect(created.payload).toMatchObject({
          threadId: NEW_THREAD_ID,
          projectId: PROJECT_ID,
          title: "Source Thread (fork)",
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: "feature/source",
          worktreePath: "/tmp/project-fork",
        });
      }

      const copiedMessages = events.slice(1, 5);
      expect(copiedMessages.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
        "thread.message-sent",
      ]);
      expect(
        copiedMessages.map((event) =>
          event.type === "thread.message-sent"
            ? {
                threadId: event.payload.threadId,
                role: event.payload.role,
                text: event.payload.text,
                providerMessageId: event.payload.providerMessageId,
                sourceIdReused: sourceMessages.some(
                  (source) => source.id === event.payload.messageId,
                ),
              }
            : null,
        ),
      ).toEqual([
        {
          threadId: NEW_THREAD_ID,
          role: "user",
          text: "first",
          providerMessageId: undefined,
          sourceIdReused: false,
        },
        {
          threadId: NEW_THREAD_ID,
          role: "assistant",
          text: "answer one",
          providerMessageId: "assistant-provider-1",
          sourceIdReused: false,
        },
        {
          threadId: NEW_THREAD_ID,
          role: "user",
          text: "second",
          providerMessageId: undefined,
          sourceIdReused: false,
        },
        {
          threadId: NEW_THREAD_ID,
          role: "assistant",
          text: "answer two",
          providerMessageId: "assistant-provider-2",
          sourceIdReused: false,
        },
      ]);

      const forked = events.at(-1);
      expect(forked?.type).toBe("thread.forked");
      if (forked?.type === "thread.forked") {
        expect(forked.aggregateId).toBe(NEW_THREAD_ID);
        expect(forked.payload).toEqual({
          sourceThreadId: SOURCE_THREAD_ID,
          forkMessageId: asMessageId("message-assistant-2"),
          mode: "full",
        });
      }
    }),
  );

  it.effect("excludes a user anchor from the copied prefix", () =>
    Effect.gen(function* () {
      const sourceMessages = [
        message({ id: "message-user-1", role: "user", text: "first" }),
        message({
          id: "message-assistant-1",
          role: "assistant",
          text: "answer one",
          providerMessageId: "assistant-provider-1",
        }),
        message({ id: "message-user-2", role: "user", text: "re-prompt me" }),
        message({
          id: "message-assistant-2",
          role: "assistant",
          text: "after anchor",
          providerMessageId: "assistant-provider-2",
        }),
      ];

      const result = yield* decideOrchestrationCommand({
        command: forkCommand({ messageId: asMessageId("message-user-2") }),
        readModel: readModel(thread({ messages: sourceMessages })),
      });

      const events = Array.isArray(result) ? result : [result];
      const copiedMessages = events.filter((event) => event.type === "thread.message-sent");
      expect(copiedMessages.map((event) => event.payload.text)).toEqual(["first", "answer one"]);
    }),
  );

  it.effect("accepts a Codex first-user anchor with an empty copied prefix", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: forkCommand({ messageId: asMessageId("message-user-1") }),
        readModel: readModel(
          thread({
            providerInstanceId: "codex",
            messages: [message({ id: "message-user-1", role: "user", text: "first" })],
          }),
        ),
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.created", "thread.forked"]);
    }),
  );

  it.effect("rejects unknown source threads", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: forkCommand({
            threadId: ThreadId.make("thread-missing"),
            messageId: asMessageId("message-user-1"),
          }),
          readModel: readModel(thread()),
        }),
      );

      expect(error.message).toContain("Thread 'thread-missing' does not exist");
    }),
  );

  it.effect("rejects message ids that do not belong to the source thread", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: forkCommand({ messageId: asMessageId("message-foreign") }),
          readModel: readModel(
            thread({ messages: [message({ id: "message-user-1", role: "user", text: "hi" })] }),
          ),
        }),
      );

      expect(error.message).toContain("thread-fork-message-not-found");
    }),
  );

  it.effect("rejects unsupported providers before emitting fork events", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: forkCommand({ messageId: asMessageId("message-assistant-1") }),
          readModel: readModel(
            thread({
              providerInstanceId: "opencode",
              messages: [
                message({
                  id: "message-assistant-1",
                  role: "assistant",
                  text: "answer",
                  providerMessageId: "assistant-provider-1",
                }),
              ],
            }),
          ),
        }),
      );

      expect(error.message).toContain("thread-fork-provider-unsupported");
    }),
  );

  it.effect("rejects summary mode until the summary slice owns it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: forkCommand({
            messageId: asMessageId("message-assistant-1"),
            mode: "summary",
          }),
          readModel: readModel(
            thread({
              messages: [
                message({
                  id: "message-assistant-1",
                  role: "assistant",
                  text: "answer",
                  providerMessageId: "assistant-provider-1",
                }),
              ],
            }),
          ),
        }),
      );

      expect(error.message).toContain("thread-fork-summary-unsupported");
    }),
  );

  it.effect("rejects non-latest assistant anchors without provider message ids", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: forkCommand({ messageId: asMessageId("message-assistant-1") }),
          readModel: readModel(
            thread({
              messages: [
                message({ id: "message-user-1", role: "user", text: "first" }),
                message({ id: "message-assistant-1", role: "assistant", text: "legacy" }),
                message({
                  id: "message-assistant-2",
                  role: "assistant",
                  text: "latest",
                  providerMessageId: "assistant-provider-2",
                }),
              ],
            }),
          ),
        }),
      );

      expect(error.message).toContain("thread-fork-anchor-unavailable");
    }),
  );
});

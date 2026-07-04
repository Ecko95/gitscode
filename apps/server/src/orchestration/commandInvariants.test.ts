import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  checkActorAuthorization,
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      visualPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      visualPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});

// ── Plan 23 (W5.3): actor authorization deny matrix ────────────────────────

describe("checkActorAuthorization", () => {
  const cmd = (
    type: OrchestrationCommand["type"],
    extra: Record<string, unknown> = {},
  ): OrchestrationCommand =>
    ({
      type,
      commandId: CommandId.make("cmd-test"),
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      ...extra,
    }) as OrchestrationCommand;

  // delamain denied for session-mutating commands
  it("denies delamain + thread.turn.start", () => {
    const err = checkActorAuthorization(
      cmd("thread.turn.start", {
        message: { messageId: MessageId.make("msg-1"), role: "user", text: "hi", attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "delamain",
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/delamain/);
  });

  it("denies delamain + thread.delete", () => {
    const err = checkActorAuthorization(cmd("thread.delete"), "delamain");
    expect(err).not.toBeNull();
  });

  // respond commands: operator allowed
  it("allows operator + thread.approval.respond", () => {
    const err = checkActorAuthorization(
      cmd("thread.approval.respond", {
        requestId: "req-1",
        decision: { type: "allow" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "operator",
    );
    expect(err).toBeNull();
  });

  // delamain with crit/supervisor credential (non-thread-scoped) allowed for respond
  it("allows delamain with owner credential + thread.approval.respond", () => {
    const err = checkActorAuthorization(
      cmd("thread.approval.respond", {
        requestId: "req-1",
        decision: { type: "allow" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "delamain",
      "owner", // crit sidecar with supervisor credential
    );
    expect(err).toBeNull();
  });

  // delamain with thread-scoped credential (peer token) must be denied for respond
  it("denies delamain with thread-scoped credential + thread.approval.respond", () => {
    const err = checkActorAuthorization(
      cmd("thread.approval.respond", {
        requestId: "req-1",
        decision: { type: "allow" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "delamain",
      "thread-scoped", // peer token must not approve its own tool use
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/thread-scoped/);
  });

  // delamain with thread-scoped credential also denied for user-input.respond
  it("denies delamain with thread-scoped credential + thread.user-input.respond", () => {
    const err = checkActorAuthorization(
      cmd("thread.user-input.respond", {
        requestId: "req-1",
        answers: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "delamain",
      "thread-scoped",
    );
    expect(err).not.toBeNull();
    expect(err?.message).toMatch(/thread-scoped/);
  });

  // delamain without sessionRole (internal server path, not HTTP) still allowed
  it("allows delamain without sessionRole + thread.approval.respond (internal path)", () => {
    const err = checkActorAuthorization(
      cmd("thread.approval.respond", {
        requestId: "req-1",
        decision: { type: "allow" },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "delamain",
      // no sessionRole: undefined — internal dispatch, not HTTP-sourced
    );
    expect(err).toBeNull();
  });

  // supervisor denied for checkpoint.revert
  it("denies supervisor + thread.checkpoint.revert", () => {
    const err = checkActorAuthorization(
      cmd("thread.checkpoint.revert", { turnCount: 1, revertedAt: "2026-01-01T00:00:00.000Z" }),
      "supervisor",
    );
    expect(err).not.toBeNull();
  });

  // operator allowed for any client command
  it("allows operator + thread.delete", () => {
    const err = checkActorAuthorization(cmd("thread.delete"), "operator");
    expect(err).toBeNull();
  });

  it("allows operator + thread.turn.start", () => {
    const err = checkActorAuthorization(
      cmd("thread.turn.start", {
        message: { messageId: MessageId.make("msg-2"), role: "user", text: "go", attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      "operator",
    );
    expect(err).toBeNull();
  });

  // server allowed for internal (worktree) commands
  it("allows server + worktree.bury", () => {
    const err = checkActorAuthorization(
      {
        type: "worktree.bury",
        commandId: CommandId.make("cmd-bury"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/wt" as ReturnType<typeof ThreadId.make>,
        branch: null,
        trigger: "retirement",
        finalCheckpointRef: null,
        buriedAt: "2026-01-01T00:00:00.000Z",
      } as unknown as OrchestrationCommand,
      "server",
    );
    expect(err).toBeNull();
  });

  // operator denied for internal commands
  it("denies operator + worktree.bury", () => {
    const err = checkActorAuthorization(
      {
        type: "worktree.bury",
        commandId: CommandId.make("cmd-bury"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/wt" as ReturnType<typeof ThreadId.make>,
        branch: null,
        trigger: "retirement",
        finalCheckpointRef: null,
        buriedAt: "2026-01-01T00:00:00.000Z",
      } as unknown as OrchestrationCommand,
      "operator",
    );
    expect(err).not.toBeNull();
  });
});

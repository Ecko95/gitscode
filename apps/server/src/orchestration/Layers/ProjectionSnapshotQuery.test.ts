import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { MAX_THREAD_MESSAGES, projectEvent } from "../projector.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);
const isoAtSecondOffset = (date: string, offsetSeconds: number): string => {
  const hours = Math.floor(offsetSeconds / 3_600);
  const minutes = Math.floor((offsetSeconds % 3_600) / 60);
  const seconds = offsetSeconds % 60;
  return `${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}.000Z`;
};

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          repository_profile_override,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          'work',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          repositoryProfileOverride: "work",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          parentThreadId: null,
          forkedFromMessageId: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          visualPlans: [],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          repositoryProfileOverride: "work",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread 1",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          parentThreadId: null,
          forkedFromMessageId: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }

      const threadDetailSnapshot = yield* snapshotQuery.getThreadDetailSnapshot(
        ThreadId.make("thread-1"),
      );
      assert.equal(threadDetailSnapshot.snapshotSequence, snapshot.snapshotSequence);
      assert.equal(threadDetailSnapshot.threadDetail._tag, "Some");
      if (threadDetailSnapshot.threadDetail._tag === "Some") {
        assert.deepEqual(threadDetailSnapshot.threadDetail.value, snapshot.threads[0]);
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("hydrates command read model messages so restart fork copies a complete prefix", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const messageRepository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-04-06T00:00:00.000Z";
      const projectId = asProjectId("project-command-fork");
      const sourceThreadId = ThreadId.make("thread-command-fork-source");
      const newThreadId = ThreadId.make("thread-command-fork-child");
      const anchorMessageId = asMessageId("message-command-fork-assistant-2");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      };

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Command Fork Project",
        workspaceRoot: "/tmp/command-fork-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId: sourceThreadId,
        projectId,
        title: "Command Fork Source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: "feature/command-fork",
        worktreePath: "/tmp/command-fork-project",
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: "2026-04-06T00:00:03.000Z",
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const sourceMessages = [
        {
          messageId: asMessageId("message-command-fork-user-1"),
          role: "user" as const,
          text: "first",
          providerMessageId: null,
        },
        {
          messageId: asMessageId("message-command-fork-assistant-1"),
          role: "assistant" as const,
          text: "answer one",
          providerMessageId: "provider-command-fork-assistant-1",
        },
        {
          messageId: asMessageId("message-command-fork-user-2"),
          role: "user" as const,
          text: "second",
          providerMessageId: null,
        },
        {
          messageId: anchorMessageId,
          role: "assistant" as const,
          text: "answer two",
          providerMessageId: "provider-command-fork-assistant-2",
        },
        {
          messageId: asMessageId("message-command-fork-user-3"),
          role: "user" as const,
          text: "after anchor",
          providerMessageId: null,
        },
      ];

      yield* Effect.forEach(
        sourceMessages,
        (message, index) =>
          messageRepository.upsert({
            ...message,
            threadId: sourceThreadId,
            turnId: null,
            isStreaming: false,
            createdAt: isoAtSecondOffset("2026-04-06", index),
            updatedAt: isoAtSecondOffset("2026-04-06", index),
          }),
        { concurrency: 1 },
      );

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      const sourceThread = commandReadModel.threads.find((thread) => thread.id === sourceThreadId);
      assert.deepEqual(
        sourceThread?.messages.map((message) => String(message.id)),
        sourceMessages.map((message) => String(message.messageId)),
      );
      assert.equal(
        sourceThread?.messages[3]?.providerMessageId,
        "provider-command-fork-assistant-2",
      );

      const decision = yield* decideOrchestrationCommand({
        readModel: commandReadModel,
        command: {
          type: "thread.fork",
          commandId: asCommandId("cmd-command-fork"),
          threadId: sourceThreadId,
          newThreadId,
          messageId: anchorMessageId,
          mode: "full",
          createdAt: now,
        },
      });
      const events = Array.isArray(decision) ? decision : [decision];

      assert.deepEqual(
        events.map((event) => event.type),
        [
          "thread.created",
          "thread.message-sent",
          "thread.message-sent",
          "thread.message-sent",
          "thread.message-sent",
          "thread.forked",
        ],
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "thread.message-sent")
          .map((event) => event.payload.text),
        ["first", "answer one", "second", "answer two"],
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "thread.message-sent")
          .map((event) => event.payload.providerMessageId),
        [
          undefined,
          "provider-command-fork-assistant-1",
          undefined,
          "provider-command-fork-assistant-2",
        ],
      );
    }),
  );

  it.effect("caps command read model message hydration to the newest projector window", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const messageRepository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-04-07T00:00:00.000Z";
      const projectId = asProjectId("project-command-cap");
      const threadId = ThreadId.make("thread-command-cap");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Command Cap Project",
        workspaceRoot: "/tmp/command-cap-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId,
        projectId,
        title: "Command Cap Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      yield* Effect.forEach(
        Array.from({ length: MAX_THREAD_MESSAGES + 5 }, (_, index) => index),
        (index) =>
          messageRepository.upsert({
            messageId: asMessageId(`message-command-cap-${String(index).padStart(4, "0")}`),
            threadId,
            turnId: null,
            role: index % 2 === 0 ? "user" : "assistant",
            text: `message ${index}`,
            providerMessageId: null,
            isStreaming: false,
            createdAt: isoAtSecondOffset("2026-04-07", index),
            updatedAt: isoAtSecondOffset("2026-04-07", index),
          }),
        { concurrency: 1 },
      );

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      const thread = commandReadModel.threads.find((entry) => entry.id === threadId);

      assert.equal(thread?.messages.length, MAX_THREAD_MESSAGES);
      assert.equal(String(thread?.messages[0]?.id), "message-command-cap-0005");
      assert.equal(
        String(thread?.messages.at(-1)?.id),
        `message-command-cap-${String(MAX_THREAD_MESSAGES + 4).padStart(4, "0")}`,
      );
    }),
  );

  it.effect("caps command read model activity hydration to the newest 500", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-04-07T00:00:00.000Z";
      const projectId = asProjectId("project-command-activity-cap");
      const threadId = ThreadId.make("thread-command-activity-cap");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const total = 505;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Command Activity Cap Project",
        workspaceRoot: "/tmp/command-activity-cap-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId,
        projectId,
        title: "Command Activity Cap Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      // sequences 1..total; newest 500 are sequences 6..505
      yield* Effect.forEach(
        Array.from({ length: total }, (_, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${`act-cap-${String(sequence).padStart(4, "0")}`},
              ${threadId},
              'turn-cap-1',
              'info',
              'runtime.note',
              ${`activity ${sequence}`},
              '{}',
              ${sequence},
              ${now}
            )
          `,
        { concurrency: 1 },
      );

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      const thread = commandReadModel.threads.find((entry) => entry.id === threadId);

      assert.equal(thread?.activities.length, 500);
      assert.equal(thread?.activities[0]?.sequence, 6);
      assert.equal(thread?.activities.at(-1)?.sequence, 505);
    }),
  );

  it.effect("hydrates pre-restart user messages used by revert-user-message mapping", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const messageRepository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-04-08T00:00:00.000Z";
      const projectId = asProjectId("project-command-revert");
      const threadId = ThreadId.make("thread-command-revert");
      const userMessageId = asMessageId("message-command-revert-user-1");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };

      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Command Revert Project",
        workspaceRoot: "/tmp/command-revert-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId,
        projectId,
        title: "Command Revert Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: asTurnId("turn-command-revert-1"),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: now,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });
      yield* messageRepository.upsert({
        messageId: userMessageId,
        threadId,
        turnId: asTurnId("turn-command-revert-1"),
        role: "user",
        text: "please revert from this pre-restart message",
        providerMessageId: null,
        isStreaming: false,
        createdAt: now,
        updatedAt: now,
      });

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      const thread = commandReadModel.threads.find((entry) => entry.id === threadId);
      const userMessage = thread?.messages.find((message) => message.id === userMessageId);
      assert.equal(userMessage?.turnId, asTurnId("turn-command-revert-1"));

      const decision = yield* decideOrchestrationCommand({
        readModel: commandReadModel,
        command: {
          type: "thread.checkpoint.revert",
          commandId: asCommandId("cmd-command-revert"),
          threadId,
          turnCount: 0,
          createdAt: now,
        },
      });

      const events = Array.isArray(decision) ? decision : [decision];
      assert.deepEqual(
        events.map((event) => event.type),
        ["thread.checkpoint-revert-requested"],
      );
    }),
  );

  it.effect(
    "hydrates command read model checkpoints and activities for restart revert retention",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const projectRepository = yield* ProjectionProjectRepository;
        const threadRepository = yield* ProjectionThreadRepository;
        const messageRepository = yield* ProjectionThreadMessageRepository;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-04-09T00:00:00.000Z";
        const projectId = asProjectId("project-command-revert-retention");
        const threadId = ThreadId.make("thread-command-revert-retention");
        const turnOneId = asTurnId("turn-command-revert-retention-1");
        const turnTwoId = asTurnId("turn-command-revert-retention-2");
        const keepMessageId = asMessageId("message-command-revert-retention-keep");
        const dropMessageId = asMessageId("message-command-revert-retention-drop");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        };

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_thread_messages`;
        yield* sql`DELETE FROM projection_thread_proposed_plans`;
        yield* sql`DELETE FROM projection_thread_visual_plans`;
        yield* sql`DELETE FROM projection_thread_sessions`;
        yield* sql`DELETE FROM projection_turns`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_state`;

        yield* projectRepository.upsert({
          projectId,
          title: "Command Revert Retention Project",
          workspaceRoot: "/tmp/command-revert-retention-project",
          repositoryProfileOverride: null,
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        yield* threadRepository.upsert({
          threadId,
          projectId,
          title: "Command Revert Retention Thread",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          parentThreadId: null,
          forkedFromMessageId: null,
          latestTurnId: turnTwoId,
          createdAt: now,
          updatedAt: "2026-04-09T00:00:04.000Z",
          archivedAt: null,
          latestUserMessageAt: null,
          pendingApprovalCount: 0,
          pendingUserInputCount: 0,
          hasActionableProposedPlan: 0,
          deletedAt: null,
        });

        yield* messageRepository.upsert({
          messageId: keepMessageId,
          threadId,
          turnId: turnOneId,
          role: "assistant",
          text: "keep after restart revert",
          providerMessageId: null,
          isStreaming: false,
          createdAt: "2026-04-09T00:00:01.000Z",
          updatedAt: "2026-04-09T00:00:01.000Z",
        });
        yield* messageRepository.upsert({
          messageId: dropMessageId,
          threadId,
          turnId: turnTwoId,
          role: "assistant",
          text: "drop after restart revert",
          providerMessageId: null,
          isStreaming: false,
          createdAt: "2026-04-09T00:00:02.000Z",
          updatedAt: "2026-04-09T00:00:02.000Z",
        });

        yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            ${threadId},
            ${turnOneId},
            NULL,
            NULL,
            NULL,
            ${keepMessageId},
            'completed',
            '2026-04-09T00:00:01.000Z',
            '2026-04-09T00:00:01.000Z',
            '2026-04-09T00:00:01.500Z',
            1,
            ${asCheckpointRef("refs/t3/checkpoints/restart-retention/turn/1")},
            'ready',
            '[]'
          ),
          (
            ${threadId},
            ${turnTwoId},
            NULL,
            NULL,
            NULL,
            ${dropMessageId},
            'completed',
            '2026-04-09T00:00:02.000Z',
            '2026-04-09T00:00:02.000Z',
            '2026-04-09T00:00:02.500Z',
            2,
            ${asCheckpointRef("refs/t3/checkpoints/restart-retention/turn/2")},
            'ready',
            '[]'
          )
      `;
        yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            ${asEventId("activity-command-revert-retention-keep")},
            ${threadId},
            ${turnOneId},
            'info',
            'checkpoint',
            'keep activity',
            '{}',
            1,
            '2026-04-09T00:00:01.750Z'
          ),
          (
            ${asEventId("activity-command-revert-retention-drop")},
            ${threadId},
            ${turnTwoId},
            'info',
            'checkpoint',
            'drop activity',
            '{}',
            2,
            '2026-04-09T00:00:02.750Z'
          )
      `;

        const commandReadModel = yield* snapshotQuery.getCommandReadModel();
        const hydratedThread = commandReadModel.threads.find((entry) => entry.id === threadId);
        assert.deepEqual(
          hydratedThread?.checkpoints.map((checkpoint) => String(checkpoint.turnId)),
          [String(turnOneId), String(turnTwoId)],
        );
        assert.deepEqual(
          hydratedThread?.activities.map((activity) => String(activity.turnId)),
          [String(turnOneId), String(turnTwoId)],
        );

        const decision = yield* decideOrchestrationCommand({
          readModel: commandReadModel,
          command: {
            type: "thread.revert.complete",
            commandId: asCommandId("cmd-command-revert-retention"),
            threadId,
            turnCount: 1,
            createdAt: "2026-04-09T00:00:03.000Z",
          },
        });
        const event = Array.isArray(decision) ? decision[0] : decision;
        assert.equal(event?.type, "thread.reverted");

        const afterRevert = yield* projectEvent(commandReadModel, event);
        const retainedThread = afterRevert.threads.find((entry) => entry.id === threadId);
        assert.deepEqual(
          retainedThread?.messages.map((message) => String(message.id)),
          [String(keepMessageId)],
        );
        assert.deepEqual(
          retainedThread?.activities.map((activity) => String(activity.id)),
          ["activity-command-revert-retention-keep"],
        );
        assert.deepEqual(
          retainedThread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount),
          [1],
        );
      }),
  );

  it.effect("keeps same-timestamp message hydration in insertion order", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-04-10T00:00:00.000Z";
      const projectId = asProjectId("project-command-message-order");
      const threadId = ThreadId.make("thread-command-message-order");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Command Message Order Project",
        workspaceRoot: "/tmp/command-message-order-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId,
        projectId,
        title: "Command Message Order Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: now,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          provider_message_id,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES
          (
            'message-command-order-b',
            ${threadId},
            NULL,
            'user',
            'first inserted',
            NULL,
            NULL,
            0,
            ${now},
            ${now}
          ),
          (
            'message-command-order-a',
            ${threadId},
            NULL,
            'assistant',
            'second inserted',
            NULL,
            NULL,
            0,
            ${now},
            ${now}
          )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      const commandThread = commandReadModel.threads.find((entry) => entry.id === threadId);
      assert.deepEqual(
        commandThread?.messages.map((message) => String(message.id)),
        ["message-command-order-b", "message-command-order-a"],
      );

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      const snapshotThread = fullSnapshot.threads.find((entry) => entry.id === threadId);
      assert.deepEqual(
        snapshotThread?.messages.map((message) => String(message.id)),
        ["message-command-order-b", "message-command-order-a"],
      );

      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.deepEqual(
        detail._tag === "Some" ? detail.value.messages.map((message) => String(message.id)) : [],
        ["message-command-order-b", "message-command-order-a"],
      );
    }),
  );

  it.effect("bounds getThreadDetailById activities to the newest MAX_THREAD_ACTIVITIES", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-05-01T00:00:00.000Z";
      const projectId = asProjectId("project-activity-bound");
      const threadId = ThreadId.make("thread-activity-bound");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };
      const total = 620;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Activity Bound Project",
        workspaceRoot: "/tmp/activity-bound-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId,
        projectId,
        title: "Activity Bound Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: now,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      // sequence 1..total, so the newest MAX (500) are sequences 121..620.
      yield* Effect.forEach(
        Array.from({ length: total }, (_, index) => index + 1),
        (sequence) =>
          sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${`activity-${String(sequence).padStart(4, "0")}`},
              ${threadId},
              'turn-1',
              'info',
              'runtime.note',
              ${`activity ${sequence}`},
              '{}',
              ${sequence},
              ${now}
            )
          `,
        { concurrency: 1 },
      );

      const detail = yield* snapshotQuery.getThreadDetailById(threadId);
      assert.equal(detail._tag, "Some");
      const activities = detail._tag === "Some" ? detail.value.activities : [];
      assert.equal(activities.length, 500);
      assert.equal(activities[0]?.sequence, 121);
      assert.equal(activities[activities.length - 1]?.sequence, 620);
    }),
  );

  it.effect("listThreadMessagesByTurn returns turn rows and the turn-less partition", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const projectRepository = yield* ProjectionProjectRepository;
      const threadRepository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-05-02T00:00:00.000Z";
      const projectId = asProjectId("project-messages-by-turn");
      const threadId = ThreadId.make("thread-messages-by-turn");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      };

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_thread_visual_plans`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;

      yield* projectRepository.upsert({
        projectId,
        title: "Messages By Turn Project",
        workspaceRoot: "/tmp/messages-by-turn-project",
        repositoryProfileOverride: null,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      yield* threadRepository.upsert({
        threadId,
        projectId,
        title: "Messages By Turn Thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        forkedFromMessageId: null,
        latestTurnId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestUserMessageAt: now,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text,
          attachments_json, provider_message_id, is_streaming, created_at, updated_at
        )
        VALUES
          ('msg-turn-a-1', ${threadId}, 'turn-a', 'assistant', 'a1', NULL, NULL, 0, ${now}, ${now}),
          ('msg-turn-a-2', ${threadId}, 'turn-a', 'user', 'a2', NULL, NULL, 0, ${now}, ${now}),
          ('msg-turn-b-1', ${threadId}, 'turn-b', 'assistant', 'b1', NULL, NULL, 0, ${now}, ${now}),
          ('msg-turnless', ${threadId}, NULL, 'user', 'nul', NULL, NULL, 0, ${now}, ${now})
      `;

      const listByTurn = snapshotQuery.listThreadMessagesByTurn;
      assert.ok(listByTurn);
      const turnA = yield* listByTurn(threadId, asTurnId("turn-a"));
      assert.deepEqual(
        turnA.map((message) => String(message.id)),
        ["msg-turn-a-1", "msg-turn-a-2"],
      );
      const turnless = yield* listByTurn(threadId, null);
      assert.deepEqual(
        turnless.map((message) => String(message.id)),
        ["msg-turnless"],
      );
    }),
  );

  it.effect("excludes deleted thread tombstones from command read model and snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      // deleted thread is excluded from the command read model (T5c fix)
      assert.equal(commandReadModel.threads.length, 0);

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      // deleted thread is excluded from the full snapshot too (listThreadRows now filters deleted_at IS NULL)
      assert.equal(fullSnapshot.threads.length, 0);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );

  it.effect(
    "getThreadWorktreeInfo returns worktree path and branch even after thread is deleted (plan 21 W2.2)",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'wt-project-1', 'WtProject', '/workspace/wt-proj',
            '{"provider":"codex","model":"gpt-5"}', '[]',
            '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            branch, worktree_path, latest_turn_id, latest_user_message_at,
            pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
            created_at, updated_at, deleted_at
          ) VALUES (
            'wt-thread-1', 'wt-project-1', 'Worktree Thread',
            '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
            'feat/wt-branch', '/workspace/wt-proj/.worktrees/wt-thread-1',
            NULL, NULL, 0, 0, 0,
            '2026-06-01T00:00:02.000Z', '2026-06-01T00:00:03.000Z',
            '2026-06-01T00:01:00.000Z'
          )
        `;

        const info = yield* snapshotQuery.getThreadWorktreeInfo(ThreadId.make("wt-thread-1"));
        assert.isTrue(info._tag === "Some");
        if (info._tag === "Some") {
          assert.equal(info.value.worktreePath, "/workspace/wt-proj/.worktrees/wt-thread-1");
          assert.equal(info.value.branch, "feat/wt-branch");
          assert.equal(info.value.projectWorkspaceRoot, "/workspace/wt-proj");
        }

        const noWorktree = yield* snapshotQuery.getThreadWorktreeInfo(ThreadId.make("nonexistent"));
        assert.isTrue(noWorktree._tag === "None");
      }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            NULL
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 2);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(shellSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);

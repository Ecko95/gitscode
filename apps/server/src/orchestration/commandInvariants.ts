import type {
  OrchestrationActorKind,
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import type { SessionRole } from "../auth/Services/SessionCredentialService.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotDeleted(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.deletedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already deleted and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}

// --- actor authorization (plan 23, W5.3) ---

// ponytail: narrow type guards over command.type — no abstraction layer needed
function isInternalCommand(command: OrchestrationCommand): boolean {
  const t = command.type;
  return (
    t === "worktree.retire.start" ||
    t === "worktree.bury" ||
    // W5.4b audit-only commands: emitted by server-internal services
    t === "provider.session.spawn" ||
    t === "provider.session.stop" ||
    t === "auth.session.issue" ||
    t === "auth.session.revoke" ||
    t === "auth.pairing-link.issue" ||
    t === "auth.pairing-link.revoke" ||
    t === "settings.record-change" ||
    t === "vcs.worktree.record-created" ||
    t === "vcs.worktree.record-removed"
  );
}

// Provider ingestion commands: only the "provider" actor (or server for back-compat) may dispatch.
// These are emitted by ProviderRuntimeIngestion on behalf of a running provider session.
function isProviderCommand(command: OrchestrationCommand): boolean {
  const t = command.type;
  return (
    t === "thread.message.assistant.delta" ||
    t === "thread.message.assistant.complete" ||
    t === "thread.proposed-plan.upsert" ||
    t === "thread.session.set" ||
    t === "thread.turn.diff.complete" ||
    t === "thread.activity.append"
  );
}

function isStructuralCommand(command: OrchestrationCommand): boolean {
  const t = command.type;
  return (
    t === "thread.create" ||
    t === "thread.fork" ||
    t === "thread.delete" ||
    t === "project.create" ||
    t === "project.delete" ||
    t === "project.meta.update"
  );
}

// Session start/stop: operator + supervisor allowed; delamain denied
function isSessionStartStopCommand(command: OrchestrationCommand): boolean {
  const t = command.type;
  return t === "thread.turn.start" || t === "thread.session.stop";
}

// Config commands: operator + supervisor allowed; delamain denied
function isConfigCommand(command: OrchestrationCommand): boolean {
  const t = command.type;
  return (
    t === "thread.meta.update" ||
    t === "thread.runtime-mode.set" ||
    t === "thread.interaction-mode.set"
  );
}

function isRespondCommand(command: OrchestrationCommand): boolean {
  const t = command.type;
  return t === "thread.approval.respond" || t === "thread.user-input.respond";
}

/**
 * Check whether the given actor is authorized to dispatch the command.
 * Returns `null` if authorized, or an `OrchestrationCommandInvariantError` if denied.
 *
 * Runs before the decider so authorization cannot be bypassed by calling
 * `decideOrchestrationCommand` directly with wrong actor context.
 *
 * @param sessionRole - The credential role of the authenticated session, when
 *   available (HTTP paths). Used to distinguish crit/supervisor-credentialed
 *   delamain callers from thread-scoped peer tokens (plan 23 §4, operator decision).
 *   A session must never approve its own tool use: delamain + thread-scoped is denied.
 */
export function checkActorAuthorization(
  command: OrchestrationCommand,
  actor: OrchestrationActorKind,
  sessionRole?: SessionRole,
): OrchestrationCommandInvariantError | null {
  // Internal commands (worktree lifecycle): only server/provider
  if (isInternalCommand(command)) {
    if (actor === "server" || actor === "provider") return null;
    return invariantError(
      command.type,
      `Actor '${actor}' is not authorized to dispatch internal command '${command.type}'.`,
    );
  }
  // Provider ingestion commands: only provider (or server for internal back-compat)
  if (isProviderCommand(command)) {
    if (actor === "provider" || actor === "server") return null;
    return invariantError(
      command.type,
      `Actor '${actor}' is not authorized to dispatch provider command '${command.type}'.`,
    );
  }
  // Structural commands (create/delete thread/project): only operator or server
  if (isStructuralCommand(command)) {
    if (actor === "operator" || actor === "server") return null;
    return invariantError(
      command.type,
      `Actor '${actor}' may not create, delete, or restructure projects or threads.`,
    );
  }
  // Session start/stop: operator + supervisor; delamain denied
  if (isSessionStartStopCommand(command)) {
    if (actor === "operator" || actor === "supervisor" || actor === "server") return null;
    return invariantError(
      command.type,
      `Actor '${actor}' is not authorized for command '${command.type}'.`,
    );
  }
  // Checkpoint revert: operator only (supervisor and delamain denied per plan 23 §4)
  if (command.type === "thread.checkpoint.revert") {
    if (actor === "operator" || actor === "server") return null;
    return invariantError(
      command.type,
      `Actor '${actor}' is not authorized for command '${command.type}'.`,
    );
  }
  // Config commands: operator + supervisor + provider allowed; delamain denied
  // ponytail: provider allowed for thread.meta.update — ProviderRuntimeIngestion patches metadata
  if (isConfigCommand(command)) {
    if (
      actor === "operator" ||
      actor === "supervisor" ||
      actor === "server" ||
      actor === "provider"
    )
      return null;
    return invariantError(
      command.type,
      `Actor '${actor}' is not authorized for command '${command.type}'.`,
    );
  }
  // Respond commands (thread.approval.respond, thread.user-input.respond):
  // operator and server are always allowed.
  // delamain is allowed ONLY when the session credential is NOT thread-scoped —
  // a thread-scoped peer token must never approve its own tool use (plan 23 §4).
  // ponytail: sessionRole is server-derived at the HTTP entry; client cannot forge it.
  if (isRespondCommand(command)) {
    if (actor === "operator" || actor === "server") return null;
    if (actor === "delamain" && sessionRole !== "thread-scoped") return null;
    if (actor === "delamain" && sessionRole === "thread-scoped") {
      return invariantError(
        command.type,
        `Actor '${actor}' with thread-scoped credential is not authorized to respond to tool-use approvals. A session must not approve its own tool use.`,
      );
    }
    return invariantError(
      command.type,
      `Actor '${actor}' is not authorized to respond on behalf of this thread.`,
    );
  }
  // Default deny-by-default: operator or server (covers archive/unarchive and anything unclassified)
  if (actor === "operator" || actor === "server") return null;
  return invariantError(
    command.type,
    `Actor '${actor}' is not authorized for command '${command.type}'.`,
  );
}

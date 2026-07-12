import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildThreadStartParams,
  buildTurnStartParams,
  CodexSessionRuntimeForkTurnMismatchError,
  forkCodexThread,
  isRecoverableThreadResumeError,
  openCodexThread,
  type CodexForkResumeCursor,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const isCodexSessionRuntimeForkTurnMismatchError = Schema.is(
  CodexSessionRuntimeForkTurnMismatchError,
);

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

function makeThreadForkResponse(
  threadId: string,
  turnIds: ReadonlyArray<string>,
): CodexRpc.ClientRequestResponsesByMethod["thread/fork"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: turnIds.map((id) => ({ id, items: [] })),
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/fork"];
}

function forkCursor(input: {
  readonly anchorTurnId: string;
  readonly boundary: "before-turn" | "after-turn";
}): CodexForkResumeCursor {
  return {
    forkSession: true,
    sourceThreadId: "source-provider-thread",
    anchor: {
      boundary: input.boundary,
      turnId: input.anchorTurnId,
      checkpointFallbackAllowed: false,
    },
    sourceTurns: [
      { turnId: "source-turn-1", state: "completed", checkpointTurnCount: 1 },
      { turnId: "source-turn-2", state: "completed", checkpointTurnCount: 2 },
      { turnId: "source-turn-3", state: "completed", checkpointTurnCount: 3 },
    ],
  };
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("maps runtimeMode 'auto' to the same conservative policy as auto-accept-edits", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("Codex developer instructions", () => {
  it("mentions RTK wrappers and the Codex display-only limitation", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      assert.match(
        instructions,
        /`rtk gh`, `rtk git`, `rtk tsc`, `rtk vitest`, `rtk grep`, or `rtk pipe`/,
      );
      assert.match(instructions, /only compacts displayed output after execution/);
      assert.match(
        instructions,
        /does not rewrite commands before execution or reduce model tokens by itself/,
      );
    }
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const fallbackCalls: Array<string> = [];
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
        visualPlanMcpUrl: undefined,
        onResumeFallback: (error) =>
          Effect.sync(() => {
            fallbackCalls.push(error.message);
          }),
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
    // marker: onResumeFallback was invoked with the resume error
    assert.equal(fallbackCalls.length, 1);
    assert.match(fallbackCalls[0]!, /thread not found/i);
  });

  it("emits warn log and invokes onResumeFallback on recoverable resume failure", async () => {
    const started = makeThreadOpenResponse("fresh-thread");
    const fallbackMessages: Array<string> = [];
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "missing thread abc123",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const { messages } = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-2"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread-2",
        visualPlanMcpUrl: undefined,
        onResumeFallback: (error) =>
          Effect.sync(() => {
            fallbackMessages.push(error.message);
          }),
      }).pipe(
        Effect.withLogSpan("test"),
        Effect.map((opened) => ({ opened, messages: fallbackMessages })),
      ),
    );

    // marker surfaced: onResumeFallback called once with the resume error
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /missing thread/i);
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
          visualPlanMcpUrl: undefined,
        }),
      ),
      (error: unknown) =>
        isCodexAppServerRequestError(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});

describe("forkCodexThread", () => {
  it("calls thread/fork then rolls back the forked thread by the unmatched suffix", async () => {
    const calls: Array<{ method: "thread/fork" | "thread/rollback"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/fork">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadForkResponse("forked-provider-thread", [
            "source-turn-1",
            "source-turn-2",
            "source-turn-3",
          ]) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    const rollbackThread = (threadId: string, numTurns: number) =>
      Effect.sync(() => {
        calls.push({ method: "thread/rollback", payload: { threadId, numTurns } });
        return {
          threadId,
          turns: [
            { id: TurnId.make("source-turn-1"), items: [] },
            { id: TurnId.make("source-turn-2"), items: [] },
          ],
        } as unknown as CodexThreadSnapshot;
      });

    const snapshot = await Effect.runPromise(
      forkCodexThread({
        client,
        threadId: ThreadId.make("thread-fork"),
        cursor: forkCursor({ anchorTurnId: "source-turn-2", boundary: "after-turn" }),
        rollbackThread,
      }),
    );

    assert.equal(snapshot.threadId, "forked-provider-thread");
    assert.deepStrictEqual(calls, [
      { method: "thread/fork", payload: { threadId: "source-provider-thread" } },
      {
        method: "thread/rollback",
        payload: { threadId: "forked-provider-thread", numTurns: 1 },
      },
    ]);
  });

  it("skips thread/rollback when the forked thread already matches the retained prefix", async () => {
    const calls: Array<{ method: "thread/fork" | "thread/rollback"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/fork">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadForkResponse("forked-provider-thread", [
            "source-turn-1",
            "source-turn-2",
            "source-turn-3",
          ]) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    const rollbackThread = (threadId: string, numTurns: number) =>
      Effect.sync(() => {
        calls.push({ method: "thread/rollback", payload: { threadId, numTurns } });
        return { threadId, turns: [] } as unknown as CodexThreadSnapshot;
      });

    const snapshot = await Effect.runPromise(
      forkCodexThread({
        client,
        threadId: ThreadId.make("thread-fork"),
        cursor: forkCursor({ anchorTurnId: "source-turn-3", boundary: "after-turn" }),
        rollbackThread,
      }),
    );

    assert.equal(snapshot.threadId, "forked-provider-thread");
    assert.deepStrictEqual(calls, [
      { method: "thread/fork", payload: { threadId: "source-provider-thread" } },
    ]);
  });

  it("treats before-turn anchors as excluding the anchor turn", async () => {
    const calls: Array<{ method: "thread/fork" | "thread/rollback"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/fork">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadForkResponse("forked-provider-thread", [
            "source-turn-1",
            "source-turn-2",
            "source-turn-3",
          ]) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    const rollbackThread = (threadId: string, numTurns: number) =>
      Effect.sync(() => {
        calls.push({ method: "thread/rollback", payload: { threadId, numTurns } });
        return {
          threadId,
          turns: [{ id: TurnId.make("source-turn-1"), items: [] }],
        } as unknown as CodexThreadSnapshot;
      });

    await Effect.runPromise(
      forkCodexThread({
        client,
        threadId: ThreadId.make("thread-fork"),
        cursor: forkCursor({ anchorTurnId: "source-turn-2", boundary: "before-turn" }),
        rollbackThread,
      }),
    );

    assert.deepStrictEqual(calls, [
      { method: "thread/fork", payload: { threadId: "source-provider-thread" } },
      {
        method: "thread/rollback",
        payload: { threadId: "forked-provider-thread", numTurns: 2 },
      },
    ]);
  });

  it("fails with a typed mismatch and does not roll back when the anchor turn is absent", async () => {
    const calls: Array<{ method: "thread/fork" | "thread/rollback"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/fork">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadForkResponse("forked-provider-thread", [
            "source-turn-1",
          ]) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    const rollbackThread = (threadId: string, numTurns: number) =>
      Effect.sync(() => {
        calls.push({ method: "thread/rollback", payload: { threadId, numTurns } });
        return { threadId, turns: [] } as unknown as CodexThreadSnapshot;
      });

    await assert.rejects(
      Effect.runPromise(
        forkCodexThread({
          client,
          threadId: ThreadId.make("thread-fork"),
          cursor: forkCursor({ anchorTurnId: "source-turn-2", boundary: "after-turn" }),
          rollbackThread,
        }),
      ),
      (error: unknown) =>
        isCodexSessionRuntimeForkTurnMismatchError(error) &&
        error.message.includes("anchor turn 'source-turn-2' was not found"),
    );
    assert.deepStrictEqual(calls, [
      { method: "thread/fork", payload: { threadId: "source-provider-thread" } },
    ]);
  });

  it("fails before forking when the source projection lacks the anchor turn", async () => {
    const calls: Array<{ method: "thread/fork" | "thread/rollback"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/fork">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadForkResponse("forked-provider-thread", [
            "source-turn-1",
          ]) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    const rollbackThread = (threadId: string, numTurns: number) =>
      Effect.sync(() => {
        calls.push({ method: "thread/rollback", payload: { threadId, numTurns } });
        return { threadId, turns: [] } as unknown as CodexThreadSnapshot;
      });
    const cursor = forkCursor({ anchorTurnId: "source-turn-2", boundary: "after-turn" });

    await assert.rejects(
      Effect.runPromise(
        forkCodexThread({
          client,
          threadId: ThreadId.make("thread-fork"),
          cursor: {
            ...cursor,
            sourceTurns: [{ turnId: "source-turn-1", state: "completed", checkpointTurnCount: 1 }],
          },
          rollbackThread,
        }),
      ),
      (error: unknown) =>
        isCodexSessionRuntimeForkTurnMismatchError(error) &&
        error.message.includes("source projection turn records"),
    );
    assert.deepStrictEqual(calls, []);
  });
});

describe("buildThreadStartParams visual-plan MCP", () => {
  it("registers the visual-plan MCP via an Authorization header, not inline bearer_token", () => {
    const params = buildThreadStartParams({
      threadId: ThreadId.make("thread-browser-test"),
      cwd: "/tmp/project",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      serviceTier: undefined,
      visualPlanMcp: { url: "http://127.0.0.1:13773/api/gits/mcp/visual-plan", token: "tok-123" },
    });
    const server = (params.config as { mcp_servers: Record<string, unknown> }).mcp_servers[
      "gits-visual-plan"
    ] as { url: string; http_headers?: Record<string, string>; bearer_token?: string };
    assert.equal(server.url, "http://127.0.0.1:13773/api/gits/mcp/visual-plan");
    // codex rejects inline bearer_token for streamable_http — must use a header.
    assert.equal(server.bearer_token, undefined);
    assert.deepEqual(server.http_headers, { Authorization: "Bearer tok-123" });
  });

  it("always registers the isolated browser MCP when no visual-plan MCP is provided", () => {
    const params = buildThreadStartParams({
      threadId: ThreadId.make("thread-browser-test"),
      cwd: "/tmp/project",
      runtimeMode: "full-access",
      model: undefined,
      serviceTier: undefined,
      visualPlanMcp: undefined,
    });
    const servers = (params.config as { mcp_servers: Record<string, { args?: readonly string[] }> })
      .mcp_servers;
    assert.deepEqual(servers["gits-browser"]?.args, [
      "--session",
      "gits-thread-browser-test",
      "mcp",
    ]);
  });

  it("maps runtimeMode 'auto' to the same conservative policy as auto-accept-edits", () => {
    const params = buildThreadStartParams({
      threadId: ThreadId.make("thread-browser-test"),
      cwd: "/tmp/project",
      runtimeMode: "auto",
      model: undefined,
      serviceTier: undefined,
      visualPlanMcp: undefined,
    });

    assert.equal(params.cwd, "/tmp/project");
    assert.equal(params.approvalPolicy, "on-request");
    assert.equal(params.sandbox, "workspace-write");
  });
});

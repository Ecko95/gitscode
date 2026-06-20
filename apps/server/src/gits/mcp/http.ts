/**
 * Native visual-plan MCP endpoint.
 *
 * A minimal Streamable-HTTP MCP server (JSON-RPC 2.0 over POST) that any agent
 * provider (Claude / Codex / Cursor) connects to with a per-session bearer
 * token. Tool calls are resolved to the owning thread via the token and
 * dispatched into the orchestration engine as `thread.visual-plan.upsert`
 * commands, so the plan renders live in the GITS visual plan panel.
 */
import { PlanContent, PlanContentPatch, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { browserApiCorsHeaders } from "../../httpCors.ts";
import {
  resolveVisualPlanThread,
  VISUAL_PLAN_MCP_PATH,
  type VisualPlanState,
} from "./VisualPlanMcpRegistry.ts";
import {
  applyPlanPatches,
  buildBlockCatalog,
  exportPlanToMarkdown,
  VISUAL_PLAN_TOOLS,
} from "./visualPlanModel.ts";
import { loadVisualPlanState, upsertVisualPlanState } from "./visualPlanWrite.ts";

const PROTOCOL_VERSION = "2025-06-18";

const decodeContent = Schema.decodeUnknownEffect(PlanContent);
const decodePatches = Schema.decodeUnknownEffect(Schema.Array(PlanContentPatch));
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const jsonString = (value: unknown): string => encodeJson(value);

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id, result },
    { status: 200, headers: browserApiCorsHeaders },
  );
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: 200, headers: browserApiCorsHeaders },
  );
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

const bearerFromRequest = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> => {
  const header = request.headers["authorization"] ?? request.headers["Authorization"];
  if (!header) {
    return Option.none();
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const value = match?.[1];
  return value ? Option.some(value.trim()) : Option.none();
};

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const callTool = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    switch (name) {
      case "get-plan-blocks":
        return toolText(jsonString(buildBlockCatalog()));

      case "get-visual-plan": {
        const state = yield* loadVisualPlanState(threadId);
        return Option.isSome(state)
          ? toolText(jsonString(state.value.content))
          : toolText("No visual plan exists yet for this session.");
      }

      case "get-plan-feedback": {
        const state = yield* loadVisualPlanState(threadId);
        const comments = Option.isSome(state) ? state.value.comments : [];
        return toolText(jsonString(comments));
      }

      case "export-visual-plan": {
        const state = yield* loadVisualPlanState(threadId);
        return Option.isSome(state)
          ? toolText(exportPlanToMarkdown(state.value.content, state.value.comments))
          : toolText("No visual plan exists yet for this session.");
      }

      case "create-visual-plan": {
        const decoded = yield* Effect.option(decodeContent(args.content));
        if (Option.isNone(decoded)) {
          return toolText("Invalid plan content. Call get-plan-blocks and retry.", true);
        }
        const existing = yield* loadVisualPlanState(threadId);
        const at = yield* nowIso;
        const next: VisualPlanState = {
          planId: Option.isSome(existing) ? existing.value.planId : `vp_${threadId}`,
          content: decoded.value,
          comments: Option.isSome(existing) ? existing.value.comments : [],
          createdAt: Option.isSome(existing) ? existing.value.createdAt : at,
        };
        yield* upsertVisualPlanState(threadId, next);
        return toolText(
          "Visual plan created. It is now rendering in the GITS visual plan side panel.",
        );
      }

      case "update-visual-plan": {
        const decoded = yield* Effect.option(decodePatches(args.contentPatches));
        if (Option.isNone(decoded)) {
          return toolText("Invalid contentPatches. Call get-plan-blocks and retry.", true);
        }
        const existing = yield* loadVisualPlanState(threadId);
        if (Option.isNone(existing)) {
          return toolText("No visual plan to update. Call create-visual-plan first.", true);
        }
        const nextContent = applyPlanPatches(existing.value.content, decoded.value);
        yield* upsertVisualPlanState(threadId, { ...existing.value, content: nextContent });
        return toolText("Visual plan updated.");
      }

      default:
        return toolText(`Unknown tool: ${name}`, true);
    }
  });

export const visualPlanMcpRouteLayer = HttpRouter.add(
  "POST",
  VISUAL_PLAN_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    const token = bearerFromRequest(request);
    if (Option.isNone(token)) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing bearer token" } },
        { status: 401, headers: browserApiCorsHeaders },
      );
    }
    const threadId = resolveVisualPlanThread(token.value);
    if (!threadId) {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid session token" } },
        { status: 401, headers: browserApiCorsHeaders },
      );
    }

    const body = yield* Effect.option(HttpServerRequest.schemaBodyJson(Schema.Unknown));
    const message = (Option.getOrElse(body, () => ({})) ?? {}) as JsonRpcMessage;

    const method = message.method ?? "";
    const id = message.id ?? null;

    if (method.startsWith("notifications/")) {
      return HttpServerResponse.empty({ status: 202 });
    }

    switch (method) {
      case "initialize": {
        const requested =
          (message.params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION;
        return jsonRpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "gits-visual-plan", version: "0.1.0" },
        });
      }
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: VISUAL_PLAN_TOOLS });
      case "tools/call": {
        const name = (message.params?.name as string | undefined) ?? "";
        const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
        const result = yield* callTool(threadId, name, args);
        return jsonRpcResult(id, result);
      }
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }).pipe(
    Effect.catch((cause: unknown) =>
      Effect.gen(function* () {
        yield* Effect.logError("visual-plan MCP route failed", cause);
        return HttpServerResponse.jsonUnsafe(
          { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } },
          { status: 200, headers: browserApiCorsHeaders },
        );
      }),
    ),
  ),
);

/**
 * Process-global registry backing the native visual-plan MCP endpoint.
 *
 * Maps per-session bearer tokens to their thread, and caches the latest plan
 * state per thread so the `update-visual-plan` tool can apply patches against
 * the current content. Implemented as a module-level singleton (not an Effect
 * service) so the MCP route and the provider adapters share one instance
 * without threading a layer requirement through the entire provider stack.
 */
import { randomUUID } from "node:crypto";
import type { PlanComment, PlanContent, ThreadId } from "@t3tools/contracts";

/** HTTP path of the native visual-plan MCP endpoint. */
export const VISUAL_PLAN_MCP_PATH = "/api/gits/visual-plan/mcp";

export interface VisualPlanState {
  readonly planId: string;
  readonly content: PlanContent;
  readonly comments: ReadonlyArray<PlanComment>;
  readonly createdAt: string;
}

const tokensToThread = new Map<string, ThreadId>();
const threadToToken = new Map<ThreadId, string>();
const threadState = new Map<ThreadId, VisualPlanState>();

/** Mint (or reuse) a bearer token for a thread's MCP session. */
export function issueVisualPlanToken(threadId: ThreadId): string {
  const existing = threadToToken.get(threadId);
  if (existing) {
    return existing;
  }
  const token = `vpmcp_${randomUUID()}`;
  tokensToThread.set(token, threadId);
  threadToToken.set(threadId, token);
  return token;
}

export function resolveVisualPlanThread(token: string): ThreadId | undefined {
  return tokensToThread.get(token);
}

export function getVisualPlanState(threadId: ThreadId): VisualPlanState | undefined {
  return threadState.get(threadId);
}

export function setVisualPlanState(threadId: ThreadId, state: VisualPlanState): void {
  threadState.set(threadId, state);
}

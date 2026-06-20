/**
 * In-memory registry backing the native visual-plan MCP endpoint.
 *
 * Maps per-session bearer tokens to their thread, and caches the latest plan
 * state per thread so the `update-visual-plan` tool can apply patches against
 * the current content. Tokens are minted when a provider session starts and
 * injected into the agent's environment; the MCP route resolves the thread
 * from the token on each call.
 */
import type { PlanComment, PlanContent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

export interface VisualPlanState {
  readonly planId: string;
  readonly content: PlanContent;
  readonly comments: ReadonlyArray<PlanComment>;
  readonly createdAt: string;
}

interface RegistryState {
  readonly tokens: ReadonlyMap<string, ThreadId>;
  readonly threadTokens: ReadonlyMap<ThreadId, string>;
  readonly states: ReadonlyMap<ThreadId, VisualPlanState>;
}

export interface VisualPlanMcpRegistryShape {
  /** Mint (or reuse) a bearer token for a thread's MCP session. */
  readonly issueToken: (threadId: ThreadId) => Effect.Effect<string, never, Crypto.Crypto>;
  readonly resolveThread: (token: string) => Effect.Effect<Option.Option<ThreadId>>;
  readonly getState: (threadId: ThreadId) => Effect.Effect<Option.Option<VisualPlanState>>;
  readonly setState: (threadId: ThreadId, state: VisualPlanState) => Effect.Effect<void>;
}

export class VisualPlanMcpRegistry extends Context.Service<
  VisualPlanMcpRegistry,
  VisualPlanMcpRegistryShape
>()("t3/gits/mcp/VisualPlanMcpRegistry") {}

const makeRegistry = Effect.gen(function* () {
  const ref = yield* Ref.make<RegistryState>({
    tokens: new Map(),
    threadTokens: new Map(),
    states: new Map(),
  });

  const issueToken: VisualPlanMcpRegistryShape["issueToken"] = (threadId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(ref);
      const existing = current.threadTokens.get(threadId);
      if (existing) {
        return existing;
      }
      const crypto = yield* Crypto.Crypto;
      const uuid = yield* Effect.orDie(crypto.randomUUIDv4);
      const token = `vpmcp_${uuid}`;
      yield* Ref.update(ref, (state) => {
        const tokens = new Map(state.tokens);
        tokens.set(token, threadId);
        const threadTokens = new Map(state.threadTokens);
        threadTokens.set(threadId, token);
        return { ...state, tokens, threadTokens };
      });
      return token;
    });

  const resolveThread: VisualPlanMcpRegistryShape["resolveThread"] = (token) =>
    Effect.map(Ref.get(ref), (state) => Option.fromNullishOr(state.tokens.get(token)));

  const getState: VisualPlanMcpRegistryShape["getState"] = (threadId) =>
    Effect.map(Ref.get(ref), (state) => Option.fromNullishOr(state.states.get(threadId)));

  const setState: VisualPlanMcpRegistryShape["setState"] = (threadId, value) =>
    Ref.update(ref, (state) => {
      const states = new Map(state.states);
      states.set(threadId, value);
      return { ...state, states };
    });

  return { issueToken, resolveThread, getState, setState } satisfies VisualPlanMcpRegistryShape;
});

export const VisualPlanMcpRegistryLive = Layer.effect(VisualPlanMcpRegistry, makeRegistry);

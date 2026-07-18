import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { ORCHESTRATION_WS_METHODS, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import { createWsRpcClient } from "./wsRpcClient.ts";
import type { WsTransport } from "./wsTransport.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  prChecks: null,
};

describe("createWsRpcClient", () => {
  it("runs beforeReconnect before awaiting transport.reconnect", async () => {
    const order: string[] = [];
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => {
        order.push("reconnect");
      }),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport, {
      beforeReconnect: () => {
        order.push("beforeReconnect");
      },
    });

    await client.reconnect();
    expect(order).toEqual(["beforeReconnect", "reconnect"]);
  });

  it("delegates heartbeat freshness to the transport", () => {
    const isHeartbeatFresh = vi.fn(() => true);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh,
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);

    expect(client.isHeartbeatFresh()).toBe(true);
    expect(isHeartbeatFresh).toHaveBeenCalledOnce();
  });

  it("routes GITS notes requests through their matching RPC methods", () => {
    const request = vi.fn();
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request,
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const write = { id: "note.md", title: "Note", content: "# Note" };

    client.gits.notes.list({});
    client.gits.notes.read({ id: write.id });
    client.gits.notes.create(write);
    client.gits.notes.update(write);
    client.gits.notes.remove({ id: write.id });
    client.gits.notes.sync({});

    expect(request).toHaveBeenCalledTimes(6);
    const transportClient = new Proxy({}, { get: (_target, method) => () => method }) as Record<
      string,
      () => string
    >;
    expect(request.mock.calls.map(([send]) => send(transportClient))).toEqual([
      WS_METHODS.gitsNotesList,
      WS_METHODS.gitsNotesRead,
      WS_METHODS.gitsNotesCreate,
      WS_METHODS.gitsNotesUpdate,
      WS_METHODS.gitsNotesRemove,
      WS_METHODS.gitsNotesSync,
    ]);
  });

  it("reduces vcs status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
          prChecks: null,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
  });

  it("tags stream subscriptions for targeted resubscribe handling", () => {
    const subscribe = vi.fn(() => () => undefined);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.terminal.onMetadata(listener);
    client.vcs.onStatus({ cwd: "/repo" }, listener);
    client.server.subscribeConfig(listener);
    client.orchestration.subscribeThread({ threadId: ThreadId.make("thread-1") }, listener);

    const subscribeCalls = subscribe.mock.calls as unknown as Array<
      readonly [unknown, unknown, { readonly tag?: string }?]
    >;
    expect(subscribeCalls.map((call) => call[2]?.tag)).toEqual([
      WS_METHODS.subscribeTerminalMetadata,
      WS_METHODS.subscribeVcsStatus,
      WS_METHODS.subscribeServerConfig,
      ORCHESTRATION_WS_METHODS.subscribeThread,
    ]);
  });
});

describe("resumable orchestration subscriptions", () => {
  // Every RPC method echoes its input, so invoking the captured `connect` with
  // this client returns exactly the input the subscription would send.
  const echoClient = new Proxy(
    {},
    { get: () => (input: unknown) => input },
  ) as unknown as Parameters<Parameters<WsTransport["subscribe"]>[0]>[0];

  function createCapturingTransport() {
    const captured: {
      connect?: (client: typeof echoClient) => unknown;
      listener?: (item: unknown) => void;
    } = {};
    const subscribe = vi.fn(<TValue>(connect: unknown, listener: (value: TValue) => void) => {
      captured.connect = connect as (client: typeof echoClient) => unknown;
      captured.listener = listener as (item: unknown) => void;
      return () => undefined;
    });
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;
    return { transport, captured };
  }

  it("subscribeThread omits afterSequence on first subscribe and sends the max seen sequence on resubscribe", () => {
    const { transport, captured } = createCapturingTransport();
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.orchestration.subscribeThread({ threadId: ThreadId.make("thread-1") }, listener);

    // (a) first subscribe: no afterSequence -> server sends a full snapshot.
    expect(captured.connect!(echoClient)).toEqual({ threadId: "thread-1" });

    captured.listener!({ kind: "snapshot", snapshot: { snapshotSequence: 5, thread: {} } });
    captured.listener!({ kind: "event", event: { sequence: 6 } });
    captured.listener!({ kind: "event", event: { sequence: 7 } });
    expect(listener).toHaveBeenCalledTimes(3);

    // (b) resubscribe with retained state: afterSequence == highest sequence seen.
    expect(captured.connect!(echoClient)).toEqual({ threadId: "thread-1", afterSequence: 7 });
  });

  it("subscribeThread drops resume-replay events at or below the high-water mark", () => {
    const { transport, captured } = createCapturingTransport();
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.orchestration.subscribeThread({ threadId: ThreadId.make("thread-1") }, listener);
    captured.listener!({ kind: "snapshot", snapshot: { snapshotSequence: 5, thread: {} } });
    captured.listener!({ kind: "event", event: { sequence: 6 } });
    captured.listener!({ kind: "event", event: { sequence: 7 } });
    listener.mockClear();

    // (c) the catch-up/live seam can redeliver already-applied events; only the
    // genuinely-new event is forwarded.
    captured.listener!({ kind: "event", event: { sequence: 7 } });
    captured.listener!({ kind: "event", event: { sequence: 6 } });
    captured.listener!({ kind: "event", event: { sequence: 8 } });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ kind: "event", event: { sequence: 8 } });
  });

  it("subscribeShell omits afterSequence on first subscribe and resumes from the max seen sequence", () => {
    const { transport, captured } = createCapturingTransport();
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.orchestration.subscribeShell(listener);

    expect(captured.connect!(echoClient)).toEqual({});

    captured.listener!({ kind: "snapshot", snapshot: { snapshotSequence: 10 } });
    captured.listener!({ kind: "thread-removed", sequence: 11, threadId: "thread-1" });

    expect(captured.connect!(echoClient)).toEqual({ afterSequence: 11 });
  });
});

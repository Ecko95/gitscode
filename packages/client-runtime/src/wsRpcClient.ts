import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type LocalApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import { type WsRpcProtocolClient } from "./wsRpcProtocol.ts";
import { WsTransport } from "./wsTransport.ts";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
  /** Called when the subscription loop terminates due to a non-transport error (e.g. server-side overflow). */
  readonly onEnd?: (error: unknown) => void;
}

function subscriptionOptions(
  options: StreamSubscriptionOptions | undefined,
  tag: string,
): StreamSubscriptionOptions & { readonly tag: string } {
  return {
    ...options,
    tag,
  };
}

/**
 * Wrap a resumable snapshot+event subscription. Tracks the highest sequence
 * already delivered to `listener` and, on transport-level resubscribe (the
 * transport re-invokes `connect` after a drop while the in-memory state built
 * from earlier items is retained), passes it as `afterSequence` so the server
 * replays only the delta instead of re-sending the full snapshot. A fresh
 * subscribe — a new call, nothing seen yet — omits `afterSequence` and gets the
 * full snapshot. The high-water mark lives for the lifetime of this one
 * transport.subscribe call, exactly as long as the caller's retained state does.
 *
 * The server's resume replay overlaps the live stream at the seam (an event can
 * appear in both the catch-up replay and the live queue), so items at or below
 * the high-water mark are dropped here — the caller never applies a delta twice.
 */
function subscribeResumableStream<TItem>(
  transport: WsTransport,
  connect: (
    client: WsRpcProtocolClient,
    afterSequence: number | undefined,
  ) => Stream.Stream<TItem, Error, never>,
  sequenceOf: (item: TItem) => number,
  listener: (item: TItem) => void,
  options: StreamSubscriptionOptions & { readonly tag: string },
): () => void {
  let maxSequence = -1;
  return transport.subscribe(
    (client) => connect(client, maxSequence >= 0 ? maxSequence : undefined),
    (item) => {
      const sequence = sequenceOf(item);
      if (sequence <= maxSequence) {
        return;
      }
      maxSequence = sequence;
      listener(item);
    },
    options,
  );
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly isHeartbeatFresh: () => boolean;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly attach: RpcInputStreamMethod<typeof WS_METHODS.terminalAttach>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
    readonly onMetadata: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalMetadata>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly sourceControl: {
    readonly lookupRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlLookupRepository>;
    readonly cloneRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlCloneRepository>;
    readonly publishRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlPublishRepository>;
  };
  readonly audio: {
    readonly transcribe: RpcUnaryMethod<typeof WS_METHODS.audioTranscribe>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
    readonly openInTerminal: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInTerminal"]>[0];
    }) => ReturnType<LocalApi["shell"]["openInTerminal"]>;
  };
  readonly vcs: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.vcsPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshStatus>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeVcsStatus>,
      listener: (status: VcsStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly listRefs: RpcUnaryMethod<typeof WS_METHODS.vcsListRefs>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsRemoveWorktree>;
    readonly createRef: RpcUnaryMethod<typeof WS_METHODS.vcsCreateRef>;
    readonly switchRef: RpcUnaryMethod<typeof WS_METHODS.vcsSwitchRef>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.vcsInit>;
  };
  readonly git: {
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  readonly review: {
    readonly getDiffPreview: RpcUnaryMethod<typeof WS_METHODS.reviewGetDiffPreview>;
  };
  readonly crit: {
    readonly ensureSidecar: RpcUnaryMethod<typeof WS_METHODS.critEnsureSidecar>;
    readonly sidecarStatus: RpcUnaryMethod<typeof WS_METHODS.critSidecarStatus>;
    readonly releaseSidecar: RpcUnaryMethod<typeof WS_METHODS.critReleaseSidecar>;
  };
  readonly browserPreview: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.browserPreviewOpen>;
    readonly status: RpcUnaryMethod<typeof WS_METHODS.browserPreviewStatus>;
    readonly control: RpcUnaryMethod<typeof WS_METHODS.browserPreviewControl>;
  };
  readonly gits: {
    readonly getCockpit: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsGetCockpit>;
    readonly devCommands: {
      readonly list: RpcUnaryMethod<typeof WS_METHODS.gitsDevCommandsList>;
      readonly init: RpcUnaryMethod<typeof WS_METHODS.gitsDevCommandsInit>;
    };
    readonly ports: {
      readonly list: RpcUnaryMethod<typeof WS_METHODS.gitsPortsList>;
    };
    readonly notes: {
      readonly list: RpcUnaryMethod<typeof WS_METHODS.gitsNotesList>;
      readonly read: RpcUnaryMethod<typeof WS_METHODS.gitsNotesRead>;
      readonly create: RpcUnaryMethod<typeof WS_METHODS.gitsNotesCreate>;
      readonly update: RpcUnaryMethod<typeof WS_METHODS.gitsNotesUpdate>;
      readonly remove: RpcUnaryMethod<typeof WS_METHODS.gitsNotesRemove>;
      readonly sync: RpcUnaryMethod<typeof WS_METHODS.gitsNotesSync>;
    };
    readonly visualPlan: {
      readonly mutate: RpcUnaryMethod<typeof WS_METHODS.gitsVisualPlanMutate>;
    };
    readonly delamain: {
      readonly listPeers: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsDelamainListPeers>;
      readonly getPeerStatus: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainGetPeerStatus>;
      readonly readPeerLog: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainReadPeerLog>;
      readonly readPeerLogParsed: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainReadPeerLogParsed>;
      readonly spawnPeer: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainSpawnPeer>;
      readonly killPeer: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainKillPeer>;
      readonly sendPeerReply: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainSendPeerReply>;
      readonly waitForPeer: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainWaitForPeer>;
      readonly integratePeer: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainIntegratePeer>;
      readonly workflow: {
        readonly status: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainWorkflowStatus>;
        readonly kill: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainWorkflowKill>;
        readonly run: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainRunWorkflow>;
      };
      readonly messages: {
        readonly inbox: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainReadInbox>;
        readonly send: RpcUnaryMethod<typeof WS_METHODS.gitsDelamainSendMessage>;
      };
    };
    readonly openGsd: {
      readonly getStatus: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsOpenGsdGetStatus>;
      readonly initProject: RpcUnaryMethod<typeof WS_METHODS.gitsOpenGsdInitProject>;
      readonly runAuto: RpcUnaryMethod<typeof WS_METHODS.gitsOpenGsdRunAuto>;
    };
    readonly automode: {
      readonly getSnapshot: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsAutomodeGetSnapshot>;
      readonly updatePolicy: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeUpdatePolicy>;
      readonly enqueueGoal: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeEnqueueGoal>;
      readonly approveGoal: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeApproveGoal>;
      readonly rejectGoal: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeRejectGoal>;
      readonly dispatchGoal: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeDispatchGoal>;
      readonly schedulerSnapshot: RpcUnaryNoArgMethod<
        typeof WS_METHODS.gitsAutomodeSchedulerSnapshot
      >;
      readonly schedulerSetConfig: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeSchedulerSetConfig>;
      readonly schedulerArm: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsAutomodeSchedulerArm>;
      readonly schedulerDisarm: RpcUnaryMethod<typeof WS_METHODS.gitsAutomodeSchedulerDisarm>;
      readonly resumeDriver: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsAutomodeDriverResume>;
    };
    readonly capacity: {
      readonly getSnapshot: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsCapacityGetSnapshot>;
    };
    readonly hermes: {
      readonly getStatus: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsHermesGetStatus>;
      readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsHermesGetConfig>;
      readonly check: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsHermesCheck>;
      readonly setupCodexOAuth: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsHermesSetupCodexOAuth>;
      readonly startAcpSession: RpcUnaryMethod<typeof WS_METHODS.gitsHermesStartAcpSession>;
      readonly listSessions: RpcUnaryMethod<typeof WS_METHODS.gitsHermesListSessions>;
      readonly tailLog: RpcUnaryMethod<typeof WS_METHODS.gitsHermesTailLog>;
      readonly listProposals: RpcUnaryNoArgMethod<typeof WS_METHODS.gitsHermesListProposals>;
      readonly inspectGits: RpcUnaryMethod<typeof WS_METHODS.gitsHermesInspectGits>;
      readonly chat: RpcUnaryMethod<typeof WS_METHODS.gitsHermesChat>;
      readonly decideProposal: RpcUnaryMethod<typeof WS_METHODS.gitsHermesDecideProposal>;
      readonly writeProjectContext: RpcUnaryMethod<typeof WS_METHODS.gitsHermesWriteProjectContext>;
      readonly draftFromProposal: RpcUnaryMethod<typeof WS_METHODS.gitsHermesDraftFromProposal>;
      readonly runSchedule: RpcUnaryMethod<typeof WS_METHODS.gitsHermesRunSchedule>;
    };
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly refreshProviders: (
      input?: RpcInput<typeof WS_METHODS.serverRefreshProviders>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverRefreshProviders>>;
    readonly discoverSourceControl: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverDiscoverSourceControl
    >;
    readonly updateProvider: RpcUnaryMethod<typeof WS_METHODS.serverUpdateProvider>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly removeKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverRemoveKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
    readonly getTraceDiagnostics: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetTraceDiagnostics>;
    readonly getProcessDiagnostics: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetProcessDiagnostics
    >;
    readonly getProcessResourceHistory: RpcUnaryMethod<
      typeof WS_METHODS.serverGetProcessResourceHistory
    >;
    readonly signalProcess: RpcUnaryMethod<typeof WS_METHODS.serverSignalProcess>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getArchivedShellSnapshot: RpcUnaryNoArgMethod<
      typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
    >;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
  readonly provider: {
    readonly steerTurn: RpcUnaryMethod<typeof WS_METHODS.providerSteerTurn>;
    readonly generateFollowUpSuggestions: RpcUnaryMethod<
      typeof WS_METHODS.providerGenerateFollowUpSuggestions
    >;
    readonly codexAccountUsage: RpcUnaryMethod<typeof WS_METHODS.providerCodexAccountUsage>;
    readonly usageModelBreakdown: RpcUnaryMethod<typeof WS_METHODS.usageModelBreakdown>;
    readonly consumeCodexResetCredit: RpcUnaryMethod<
      typeof WS_METHODS.providerConsumeCodexResetCredit
    >;
    readonly auth: {
      readonly start: RpcUnaryMethod<typeof WS_METHODS.providerAuthStart>;
      readonly get: RpcUnaryMethod<typeof WS_METHODS.providerAuthGet>;
      readonly cancel: RpcUnaryMethod<typeof WS_METHODS.providerAuthCancel>;
      readonly submitCode: RpcUnaryMethod<typeof WS_METHODS.providerAuthSubmitCode>;
      readonly logout: RpcUnaryMethod<typeof WS_METHODS.providerAuthLogout>;
    };
  };
}

export interface CreateWsRpcClientOptions {
  /** Runs immediately before `transport.reconnect()` (e.g. reset reconnect UI/backoff state). */
  readonly beforeReconnect?: () => void;
}

export function createWsRpcClient(
  transport: WsTransport,
  options?: CreateWsRpcClientOptions,
): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    isHeartbeatFresh: () => transport.isHeartbeatFresh(),
    reconnect: async () => {
      options?.beforeReconnect?.();
      await transport.reconnect();
    },
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      attach: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.terminalAttach](input),
          listener,
          subscriptionOptions(options, WS_METHODS.terminalAttach),
        ),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          listener,
          subscriptionOptions(options, WS_METHODS.subscribeTerminalEvents),
        ),
      onMetadata: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalMetadata]({}),
          listener,
          subscriptionOptions(options, WS_METHODS.subscribeTerminalMetadata),
        ),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    sourceControl: {
      lookupRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlLookupRepository](input)),
      cloneRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlCloneRepository](input)),
      publishRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlPublishRepository](input)),
    },
    audio: {
      transcribe: (input) =>
        transport.request((client) => client[WS_METHODS.audioTranscribe](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
      openInTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInTerminal](input)),
    },
    vcs: {
      pull: (input) => transport.request((client) => client[WS_METHODS.vcsPull](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshStatus](input)),
      onStatus: (input, listener, options) => {
        let current: VcsStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeVcsStatus](input),
          (event: VcsStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          subscriptionOptions(options, WS_METHODS.subscribeVcsStatus),
        );
      },
      listRefs: (input) => transport.request((client) => client[WS_METHODS.vcsListRefs](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRemoveWorktree](input)),
      createRef: (input) => transport.request((client) => client[WS_METHODS.vcsCreateRef](input)),
      switchRef: (input) => transport.request((client) => client[WS_METHODS.vcsSwitchRef](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.vcsInit](input)),
    },
    git: {
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    review: {
      getDiffPreview: (input) =>
        transport.request((client) => client[WS_METHODS.reviewGetDiffPreview](input)),
    },
    crit: {
      ensureSidecar: (input) =>
        transport.request((client) => client[WS_METHODS.critEnsureSidecar](input)),
      sidecarStatus: (input) =>
        transport.request((client) => client[WS_METHODS.critSidecarStatus](input)),
      releaseSidecar: (input) =>
        transport.request((client) => client[WS_METHODS.critReleaseSidecar](input)),
    },
    browserPreview: {
      open: (input) => transport.request((client) => client[WS_METHODS.browserPreviewOpen](input)),
      status: (input) =>
        transport.request((client) => client[WS_METHODS.browserPreviewStatus](input)),
      control: (input) =>
        transport.request((client) => client[WS_METHODS.browserPreviewControl](input)),
    },
    gits: {
      getCockpit: () => transport.request((client) => client[WS_METHODS.gitsGetCockpit]({})),
      devCommands: {
        list: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDevCommandsList](input)),
        init: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDevCommandsInit](input)),
      },
      ports: {
        list: (input) => transport.request((client) => client[WS_METHODS.gitsPortsList](input)),
      },
      notes: {
        list: (input) => transport.request((client) => client[WS_METHODS.gitsNotesList](input)),
        read: (input) => transport.request((client) => client[WS_METHODS.gitsNotesRead](input)),
        create: (input) => transport.request((client) => client[WS_METHODS.gitsNotesCreate](input)),
        update: (input) => transport.request((client) => client[WS_METHODS.gitsNotesUpdate](input)),
        remove: (input) => transport.request((client) => client[WS_METHODS.gitsNotesRemove](input)),
        sync: (input) => transport.request((client) => client[WS_METHODS.gitsNotesSync](input)),
      },
      visualPlan: {
        mutate: (input) =>
          transport.request((client) => client[WS_METHODS.gitsVisualPlanMutate](input)),
      },
      delamain: {
        listPeers: () =>
          transport.request((client) => client[WS_METHODS.gitsDelamainListPeers]({})),
        getPeerStatus: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainGetPeerStatus](input)),
        readPeerLog: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainReadPeerLog](input)),
        readPeerLogParsed: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainReadPeerLogParsed](input)),
        spawnPeer: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainSpawnPeer](input)),
        killPeer: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainKillPeer](input)),
        sendPeerReply: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainSendPeerReply](input)),
        waitForPeer: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainWaitForPeer](input)),
        integratePeer: (input) =>
          transport.request((client) => client[WS_METHODS.gitsDelamainIntegratePeer](input)),
        workflow: {
          status: (input) =>
            transport.request((client) => client[WS_METHODS.gitsDelamainWorkflowStatus](input)),
          kill: (input) =>
            transport.request((client) => client[WS_METHODS.gitsDelamainWorkflowKill](input)),
          run: (input) =>
            transport.request((client) => client[WS_METHODS.gitsDelamainRunWorkflow](input)),
        },
        messages: {
          inbox: (input) =>
            transport.request((client) => client[WS_METHODS.gitsDelamainReadInbox](input)),
          send: (input) =>
            transport.request((client) => client[WS_METHODS.gitsDelamainSendMessage](input)),
        },
      },
      openGsd: {
        getStatus: () => transport.request((client) => client[WS_METHODS.gitsOpenGsdGetStatus]({})),
        initProject: (input) =>
          transport.request((client) => client[WS_METHODS.gitsOpenGsdInitProject](input)),
        runAuto: (input) =>
          transport.request((client) => client[WS_METHODS.gitsOpenGsdRunAuto](input)),
      },
      automode: {
        getSnapshot: () =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeGetSnapshot]({})),
        updatePolicy: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeUpdatePolicy](input)),
        enqueueGoal: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeEnqueueGoal](input)),
        approveGoal: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeApproveGoal](input)),
        rejectGoal: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeRejectGoal](input)),
        dispatchGoal: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeDispatchGoal](input)),
        schedulerSnapshot: () =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeSchedulerSnapshot]({})),
        schedulerSetConfig: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeSchedulerSetConfig](input)),
        schedulerArm: () =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeSchedulerArm]({})),
        schedulerDisarm: (input) =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeSchedulerDisarm](input)),
        resumeDriver: () =>
          transport.request((client) => client[WS_METHODS.gitsAutomodeDriverResume]({})),
      },
      capacity: {
        getSnapshot: () =>
          transport.request((client) => client[WS_METHODS.gitsCapacityGetSnapshot]({})),
      },
      hermes: {
        getStatus: () => transport.request((client) => client[WS_METHODS.gitsHermesGetStatus]({})),
        getConfig: () => transport.request((client) => client[WS_METHODS.gitsHermesGetConfig]({})),
        check: () => transport.request((client) => client[WS_METHODS.gitsHermesCheck]({})),
        setupCodexOAuth: () =>
          transport.request((client) => client[WS_METHODS.gitsHermesSetupCodexOAuth]({})),
        startAcpSession: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesStartAcpSession](input)),
        listSessions: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesListSessions](input)),
        tailLog: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesTailLog](input)),
        listProposals: () =>
          transport.request((client) => client[WS_METHODS.gitsHermesListProposals]({})),
        inspectGits: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesInspectGits](input)),
        chat: (input) => transport.request((client) => client[WS_METHODS.gitsHermesChat](input)),
        decideProposal: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesDecideProposal](input)),
        writeProjectContext: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesWriteProjectContext](input)),
        draftFromProposal: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesDraftFromProposal](input)),
        runSchedule: (input) =>
          transport.request((client) => client[WS_METHODS.gitsHermesRunSchedule](input)),
      },
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: (input) =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders](input ?? {})),
      discoverSourceControl: () =>
        transport.request((client) => client[WS_METHODS.serverDiscoverSourceControl]({})),
      updateProvider: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpdateProvider](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      removeKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      subscribeConfig: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig]({}),
          listener,
          subscriptionOptions(options, WS_METHODS.subscribeServerConfig),
        ),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          listener,
          subscriptionOptions(options, WS_METHODS.subscribeServerLifecycle),
        ),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeAuthAccess]({}),
          listener,
          subscriptionOptions(options, WS_METHODS.subscribeAuthAccess),
        ),
      getTraceDiagnostics: () =>
        transport.request((client) => client[WS_METHODS.serverGetTraceDiagnostics]({})),
      getProcessDiagnostics: () =>
        transport.request((client) => client[WS_METHODS.serverGetProcessDiagnostics]({})),
      getProcessResourceHistory: (input) =>
        transport.request((client) => client[WS_METHODS.serverGetProcessResourceHistory](input)),
      signalProcess: (input) =>
        transport.request((client) => client[WS_METHODS.serverSignalProcess](input)),
    },
    orchestration: {
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getArchivedShellSnapshot: () =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({}),
        ),
      subscribeShell: (listener, options) =>
        subscribeResumableStream(
          transport,
          (client, afterSequence) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell](
              afterSequence === undefined ? {} : { afterSequence },
            ),
          (item) => (item.kind === "snapshot" ? item.snapshot.snapshotSequence : item.sequence),
          listener,
          subscriptionOptions(options, ORCHESTRATION_WS_METHODS.subscribeShell),
        ),
      subscribeThread: (input, listener, options) =>
        subscribeResumableStream(
          transport,
          (client, afterSequence) =>
            client[ORCHESTRATION_WS_METHODS.subscribeThread](
              afterSequence === undefined ? input : { ...input, afterSequence },
            ),
          (item) =>
            item.kind === "snapshot" ? item.snapshot.snapshotSequence : item.event.sequence,
          listener,
          subscriptionOptions(options, ORCHESTRATION_WS_METHODS.subscribeThread),
        ),
    },
    provider: {
      steerTurn: (input) =>
        transport.request((client) => client[WS_METHODS.providerSteerTurn](input)),
      generateFollowUpSuggestions: (input) =>
        transport.request((client) =>
          client[WS_METHODS.providerGenerateFollowUpSuggestions](input),
        ),
      codexAccountUsage: (input) =>
        transport.request((client) => client[WS_METHODS.providerCodexAccountUsage](input)),
      usageModelBreakdown: (input) =>
        transport.request((client) => client[WS_METHODS.usageModelBreakdown](input)),
      consumeCodexResetCredit: (input) =>
        transport.request((client) => client[WS_METHODS.providerConsumeCodexResetCredit](input)),
      auth: {
        start: (input) =>
          transport.request((client) => client[WS_METHODS.providerAuthStart](input)),
        get: (input) => transport.request((client) => client[WS_METHODS.providerAuthGet](input)),
        cancel: (input) =>
          transport.request((client) => client[WS_METHODS.providerAuthCancel](input)),
        submitCode: (input) =>
          transport.request((client) => client[WS_METHODS.providerAuthSubmitCode](input)),
        logout: (input) =>
          transport.request((client) => client[WS_METHODS.providerAuthLogout](input)),
      },
    },
  };
}

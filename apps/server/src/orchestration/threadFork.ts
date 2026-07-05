import type { MessageId, OrchestrationMessage, OrchestrationThread } from "@t3tools/contracts";

export type ThreadForkAnchorResolution =
  | {
      readonly _tag: "provider-message";
      readonly providerMessageId: string;
    }
  | {
      readonly _tag: "plain-resume";
    }
  | {
      readonly _tag: "missing-message";
    }
  | {
      readonly _tag: "unavailable";
    };

export function inferThreadProviderLabel(thread: OrchestrationThread): string {
  return thread.session?.providerName ?? String(thread.modelSelection.instanceId);
}

export function supportsFullThreadFork(thread: OrchestrationThread): boolean {
  const providerLabel = inferThreadProviderLabel(thread).toLowerCase();
  // ponytail: the orchestration read model has no provider-instance registry;
  // custom Claude instance ids are treated by slug prefix until command
  // preflight can resolve drivers.
  return providerLabel === "claudeagent" || providerLabel.startsWith("claude");
}

export function findThreadForkPrefix(input: {
  readonly sourceThread: OrchestrationThread;
  readonly messageId: MessageId;
}): ReadonlyArray<OrchestrationMessage> | undefined {
  const anchorIndex = input.sourceThread.messages.findIndex(
    (message) => message.id === input.messageId,
  );
  const anchor = input.sourceThread.messages[anchorIndex];
  if (!anchor) {
    return undefined;
  }
  return input.sourceThread.messages.slice(
    0,
    anchor.role === "assistant" ? anchorIndex + 1 : anchorIndex,
  );
}

export function resolveThreadForkAnchor(input: {
  readonly sourceThread: OrchestrationThread;
  readonly messageId: MessageId;
}): ThreadForkAnchorResolution {
  const anchorIndex = input.sourceThread.messages.findIndex(
    (message) => message.id === input.messageId,
  );
  const anchor = input.sourceThread.messages[anchorIndex];
  if (!anchor) {
    return { _tag: "missing-message" };
  }

  const providerMessageId =
    anchor.role === "assistant"
      ? anchor.providerMessageId
      : input.sourceThread.messages
          .slice(0, anchorIndex)
          .findLast((message) => message.role === "assistant")?.providerMessageId;
  if (providerMessageId !== undefined) {
    return {
      _tag: "provider-message",
      providerMessageId,
    };
  }

  const latestAssistant = input.sourceThread.messages.findLast(
    (message) => message.role === "assistant",
  );
  if (anchor.role === "assistant" && latestAssistant?.id === anchor.id) {
    return { _tag: "plain-resume" };
  }

  return { _tag: "unavailable" };
}

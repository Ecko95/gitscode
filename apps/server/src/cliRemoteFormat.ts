import type { RemoteAgentRecord } from "@t3tools/contracts";

const newline = "\n";

function formatTargetSpec(target: RemoteAgentRecord["target"]): string {
  const user = target.username ? `${target.username}@` : "";
  const port = target.port ? `:${target.port}` : "";
  return `${user}${target.hostname}${port}`;
}

export function formatRemoteAgentAddedJson(input: {
  readonly record: RemoteAgentRecord;
  readonly pairingToken: string | null;
}): string {
  return `${JSON.stringify(
    {
      id: input.record.id,
      alias: input.record.alias,
      httpBaseUrl: input.record.httpBaseUrl,
      wsBaseUrl: input.record.wsBaseUrl,
      remoteServerKind: input.record.remoteServerKind,
      ...(input.pairingToken ? { pairingToken: input.pairingToken } : {}),
    },
    null,
    2,
  )}${newline}`;
}

export function formatRemoteAgentList(
  agents: ReadonlyArray<RemoteAgentRecord>,
  options?: {
    readonly json?: boolean;
  },
): string {
  if (options?.json) {
    return `${JSON.stringify(
      agents.map((agent) => ({
        id: agent.id,
        alias: agent.alias,
        target: agent.target,
        httpBaseUrl: agent.httpBaseUrl,
        wsBaseUrl: agent.wsBaseUrl,
        remoteServerKind: agent.remoteServerKind,
        createdAt: agent.createdAt,
        lastSeenAt: agent.lastSeenAt,
      })),
      null,
      2,
    )}${newline}`;
  }

  if (agents.length === 0) {
    return `No saved remote agents.${newline}`;
  }

  return (
    agents
      .map((agent) =>
        [
          `${agent.alias} (${agent.id})`,
          `  ssh: ${formatTargetSpec(agent.target)}`,
          `  http: ${agent.httpBaseUrl}`,
          `  kind: ${agent.remoteServerKind ?? "unknown"}`,
          `  created: ${agent.createdAt}`,
          ...(agent.lastSeenAt ? [`  last seen: ${agent.lastSeenAt}`] : []),
        ].join(newline),
      )
      .join(`${newline}${newline}`) + newline
  );
}

export function formatRemoteAgentStatusJson(input: {
  readonly record: RemoteAgentRecord;
  readonly reachable: boolean;
}): string {
  return `${JSON.stringify(
    {
      id: input.record.id,
      alias: input.record.alias,
      httpBaseUrl: input.record.httpBaseUrl,
      reachable: input.reachable,
    },
    null,
    2,
  )}${newline}`;
}

export function formatRemoteAgentMissingJson(input: {
  readonly identifier: string;
  readonly field: "found" | "removed";
}): string {
  return `${JSON.stringify({ identifier: input.identifier, [input.field]: false }, null, 2)}${newline}`;
}

export function formatRemoteAgentRemovedJson(input: {
  readonly record: RemoteAgentRecord;
  readonly removed: boolean;
}): string {
  return `${JSON.stringify(
    { id: input.record.id, alias: input.record.alias, removed: input.removed },
    null,
    2,
  )}${newline}`;
}

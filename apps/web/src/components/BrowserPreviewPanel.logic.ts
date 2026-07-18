import type { KnownTerminalSession } from "@t3tools/client-runtime";
import type {
  PortListenerStatus,
  PortProtocol,
  PortRecord,
  PortRemoteHost,
  PortSource,
} from "@t3tools/contracts";
import { classifyEnvironmentUrl } from "@t3tools/shared/environmentUrl";

import { extractTerminalLinks } from "../terminal-links";

const SOURCE_ORDER: ReadonlyArray<PortSource> = ["configured", "terminal", "listener", "manual"];
const PROTOCOL_RANK: Record<PortProtocol, number> = { tcp: 0, http: 1, https: 2 };
const LISTENER_STATUS_RANK: Record<PortListenerStatus, number> = {
  unknown: 0,
  stopped: 1,
  starting: 2,
  error: 3,
  ready: 4,
};

function portId(host: PortRemoteHost, port: number): string {
  return host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
}

function normalizeUrlHost(hostname: string): PortRemoteHost | null {
  if (hostname === "localhost" || hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "[::]" || hostname === "::" || hostname === "[::1]" || hostname === "::1") {
    return "::1";
  }
  return /^127(?:\.\d{1,3}){3}$/u.test(hostname) ? (hostname as PortRemoteHost) : null;
}

function terminalPort(urlText: string, session: KnownTerminalSession): PortRecord | null {
  try {
    const classified = classifyEnvironmentUrl(urlText);
    if (classified.kind !== "loopback") return null;
    const protocol: PortProtocol = classified.url.protocol === "https:" ? "https" : "http";
    const host = normalizeUrlHost(classified.url.hostname);
    const port = classified.url.port
      ? Number(classified.url.port)
      : protocol === "https"
        ? 443
        : 80;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    const summary = session.state.summary;
    const owned =
      session.target.terminalId.startsWith("gits-dev-") && session.state.hasRunningSubprocess;
    return {
      id: portId(host, port),
      remoteHost: host,
      remotePort: port,
      protocol,
      ...(summary?.label ? { label: summary.label } : {}),
      sources: ["terminal"],
      listenerStatus: "unknown",
      ownership: owned ? "gits-terminal" : "unmanaged",
      threadId: session.target.threadId,
      terminalId: session.target.terminalId,
      ...(summary?.updatedAt ? { lastSeenAt: summary.updatedAt } : {}),
      supervisedStatus: "stopped",
      exposureStatus: "none",
    };
  } catch {
    return null;
  }
}

function terminalPorts(sessions: ReadonlyArray<KnownTerminalSession>): ReadonlyArray<PortRecord> {
  return sessions.flatMap((session) =>
    extractTerminalLinks(session.state.buffer).flatMap((match) => {
      if (match.kind !== "url") return [];
      const port = terminalPort(match.text, session);
      return port ? [port] : [];
    }),
  );
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function mergeRecords(records: ReadonlyArray<PortRecord>): ReadonlyArray<PortRecord> {
  const merged = new Map<string, PortRecord>();
  for (const record of records) {
    const key = portId(record.remoteHost, record.remotePort);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...record, id: key, sources: [...record.sources] });
      continue;
    }
    const sources = new Set([...current.sources, ...record.sources]);
    const protocol =
      PROTOCOL_RANK[record.protocol] > PROTOCOL_RANK[current.protocol]
        ? record.protocol
        : current.protocol;
    const listenerStatus =
      LISTENER_STATUS_RANK[record.listenerStatus] > LISTENER_STATUS_RANK[current.listenerStatus]
        ? record.listenerStatus
        : current.listenerStatus;
    const lastSeenAt = latestTimestamp(current.lastSeenAt, record.lastSeenAt);
    const newlyOwned =
      current.ownership !== "gits-terminal" && record.ownership === "gits-terminal";
    merged.set(key, {
      ...record,
      ...current,
      id: key,
      protocol,
      sources: SOURCE_ORDER.filter((source) => sources.has(source)),
      listenerStatus,
      ownership:
        current.ownership === "gits-terminal" || record.ownership === "gits-terminal"
          ? "gits-terminal"
          : "unmanaged",
      ...(newlyOwned && record.threadId ? { threadId: record.threadId } : {}),
      ...(newlyOwned && record.terminalId ? { terminalId: record.terminalId } : {}),
      ...(lastSeenAt ? { lastSeenAt } : {}),
    });
  }
  return [...merged.values()].toSorted(
    (left, right) =>
      left.remotePort - right.remotePort || left.remoteHost.localeCompare(right.remoteHost),
  );
}

export function createManualPort(port: number, protocol: PortProtocol): PortRecord {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Port must be between 1 and 65535.");
  }
  const remoteHost = "127.0.0.1";
  return {
    id: portId(remoteHost, port),
    remoteHost,
    remotePort: port,
    protocol,
    label: `Manual port ${port}`,
    sources: ["manual"],
    listenerStatus: "unknown",
    ownership: "unmanaged",
    supervisedStatus: protocol === "tcp" ? "unavailable" : "stopped",
    exposureStatus: "none",
  };
}

export function mergePortInventory(input: {
  readonly serverPorts: ReadonlyArray<PortRecord>;
  readonly terminalSessions: ReadonlyArray<KnownTerminalSession>;
  readonly manualPorts: ReadonlyArray<PortRecord>;
}): ReadonlyArray<PortRecord> {
  return mergeRecords([
    ...input.serverPorts,
    ...terminalPorts(input.terminalSessions),
    ...input.manualPorts,
  ]);
}

export function buildPortUrl(port: PortRecord): string | null {
  if (port.protocol === "tcp") return null;
  const host = port.remoteHost === "::1" ? "[::1]" : port.remoteHost;
  return `${port.protocol}://${host}:${port.remotePort}/`;
}

// @effect-diagnostics nodeBuiltinImport:off globalDate:off - one bounded OS listener snapshot.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  GitsDevCommand,
  GitsPortsError as GitsPortsErrorType,
  PortListenerStatus,
  PortOwnership,
  PortProtocol,
  PortRecord,
  PortRemoteHost,
  PortSource,
  PortsListResult,
  ThreadId,
} from "@t3tools/contracts";
import { GitsPortsError } from "@t3tools/contracts";
import { isLoopbackHostname } from "@t3tools/shared/environmentUrl";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { GitsDevCommands, type GitsDevCommandsShape } from "../Services/GitsDevCommands.ts";
import { GitsPorts, type GitsPortsShape } from "../Services/GitsPorts.ts";

const execFileAsync = promisify(execFile);
const SOURCE_ORDER: ReadonlyArray<PortSource> = ["configured", "terminal", "listener", "manual"];
const RESERVED_PORTS = new Set([22, 2375, 2376, 3306, 5432, 6379, 27_017]);

export interface PortFact {
  readonly remoteHost: PortRemoteHost;
  readonly remotePort: number;
  readonly protocol: PortProtocol;
  readonly source: PortSource;
  readonly label?: string;
  readonly listenerStatus?: PortListenerStatus;
  readonly ownership?: PortOwnership;
  readonly threadId?: ThreadId;
  readonly terminalId?: string;
  readonly commandId?: string;
  readonly pid?: number;
  readonly processName?: string;
  readonly lastSeenAt?: string;
}

interface MutablePortRecord {
  remoteHost: PortRemoteHost;
  remotePort: number;
  protocol: PortProtocol;
  label?: string;
  sources: Set<PortSource>;
  listenerStatus: PortListenerStatus;
  ownership: PortOwnership;
  threadId?: ThreadId;
  terminalId?: string;
  commandId?: string;
  pid?: number;
  processName?: string;
  lastSeenAt?: string;
}

export interface GitsPortsOptions {
  readonly controlPort: number;
  readonly listDevCommands: GitsDevCommandsShape["listCommands"];
  readonly readListeners: () => Promise<string>;
  readonly now?: () => string;
}

const protocolRank: Record<PortProtocol, number> = { tcp: 0, http: 1, https: 2 };
const listenerStatusRank: Record<PortListenerStatus, number> = {
  unknown: 0,
  stopped: 1,
  starting: 2,
  error: 3,
  ready: 4,
};

function portId(remoteHost: PortRemoteHost, remotePort: number): string {
  return remoteHost === "::1" ? `[::1]:${remotePort}` : `${remoteHost}:${remotePort}`;
}

function setOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined && target[key] === undefined) target[key] = value;
}

function toPortRecord(record: MutablePortRecord): PortRecord {
  return {
    id: portId(record.remoteHost, record.remotePort),
    remoteHost: record.remoteHost,
    remotePort: record.remotePort,
    protocol: record.protocol,
    ...(record.label ? { label: record.label } : {}),
    sources: SOURCE_ORDER.filter((source) => record.sources.has(source)),
    listenerStatus: record.listenerStatus,
    ownership: record.ownership,
    ...(record.threadId ? { threadId: record.threadId } : {}),
    ...(record.terminalId ? { terminalId: record.terminalId } : {}),
    ...(record.commandId ? { commandId: record.commandId } : {}),
    ...(record.pid ? { pid: record.pid } : {}),
    ...(record.processName ? { processName: record.processName } : {}),
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
    supervisedStatus: record.protocol === "tcp" ? "unavailable" : "stopped",
    exposureStatus: "none",
  };
}

export function mergePortFacts(facts: ReadonlyArray<PortFact>): ReadonlyArray<PortRecord> {
  const merged = new Map<string, MutablePortRecord>();
  for (const fact of facts) {
    const id = portId(fact.remoteHost, fact.remotePort);
    const current = merged.get(id);
    if (!current) {
      merged.set(id, {
        remoteHost: fact.remoteHost,
        remotePort: fact.remotePort,
        protocol: fact.protocol,
        ...(fact.label ? { label: fact.label } : {}),
        sources: new Set([fact.source]),
        listenerStatus: fact.listenerStatus ?? "unknown",
        ownership: fact.ownership ?? "unmanaged",
        ...(fact.threadId ? { threadId: fact.threadId } : {}),
        ...(fact.terminalId ? { terminalId: fact.terminalId } : {}),
        ...(fact.commandId ? { commandId: fact.commandId } : {}),
        ...(fact.pid ? { pid: fact.pid } : {}),
        ...(fact.processName ? { processName: fact.processName } : {}),
        ...(fact.lastSeenAt ? { lastSeenAt: fact.lastSeenAt } : {}),
      });
      continue;
    }

    current.sources.add(fact.source);
    if (protocolRank[fact.protocol] > protocolRank[current.protocol]) {
      current.protocol = fact.protocol;
    }
    if (
      fact.listenerStatus &&
      listenerStatusRank[fact.listenerStatus] > listenerStatusRank[current.listenerStatus]
    ) {
      current.listenerStatus = fact.listenerStatus;
    }
    if (fact.ownership === "gits-terminal") current.ownership = "gits-terminal";
    setOptional(current, "label", fact.label);
    setOptional(current, "threadId", fact.threadId);
    setOptional(current, "terminalId", fact.terminalId);
    setOptional(current, "commandId", fact.commandId);
    setOptional(current, "pid", fact.pid);
    setOptional(current, "processName", fact.processName);
    if (fact.lastSeenAt && (!current.lastSeenAt || fact.lastSeenAt > current.lastSeenAt)) {
      current.lastSeenAt = fact.lastSeenAt;
    }
  }

  return [...merged.values()]
    .sort(
      (left, right) =>
        left.remotePort - right.remotePort || left.remoteHost.localeCompare(right.remoteHost),
    )
    .map(toPortRecord);
}

function normalizeListenerHost(rawHost: string): PortRemoteHost | null {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "*" || host === "0.0.0.0" || host === "localhost") return "127.0.0.1";
  if (host === "::" || host === "::1") return "::1";
  return isLoopbackHostname(host) ? (host as PortRemoteHost) : null;
}

function parseLocalAddress(value: string): { host: PortRemoteHost; port: number } | null {
  const separator = value.lastIndexOf(":");
  if (separator < 1) return null;
  const host = normalizeListenerHost(value.slice(0, separator));
  const port = Number(value.slice(separator + 1));
  return host && Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host, port } : null;
}

export function parseSsListeners(output: string, scannedAt: string): ReadonlyArray<PortFact> {
  const facts: PortFact[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns[0] !== "LISTEN") continue;
    const address = columns[3] ? parseLocalAddress(columns[3]) : null;
    if (!address) continue;
    const processMatch = line.match(/"([^"]+)",pid=(\d+)/u);
    const pid = processMatch?.[2] ? Number(processMatch[2]) : undefined;
    const processName = processMatch?.[1];
    facts.push({
      remoteHost: address.host,
      remotePort: address.port,
      protocol: "tcp",
      source: "listener",
      listenerStatus: "ready",
      ownership: "unmanaged",
      ...(pid && Number.isInteger(pid) ? { pid } : {}),
      ...(processName ? { processName, label: processName } : {}),
      lastSeenAt: scannedAt,
    });
  }
  return facts;
}

function configuredPortFact(command: GitsDevCommand): PortFact | null {
  if (
    command.localPort === null ||
    !Number.isInteger(command.localPort) ||
    command.localPort < 1 ||
    command.localPort > 65_535
  ) {
    return null;
  }
  const remoteHost = normalizeListenerHost(command.localHost ?? "127.0.0.1");
  if (!remoteHost) return null;
  return {
    remoteHost,
    remotePort: command.localPort,
    protocol: "http",
    source: "configured",
    label: command.name,
    listenerStatus: "stopped",
    ownership: "unmanaged",
    commandId: command.id,
  };
}

function toPortsError(cause: unknown): GitsPortsErrorType {
  return new GitsPortsError({ message: "Failed to list environment ports.", cause });
}

export function makeGitsPorts(options: GitsPortsOptions): GitsPortsShape {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    list: (input) =>
      options.listDevCommands({ projectDir: input.projectDir }).pipe(
        Effect.mapError(toPortsError),
        Effect.flatMap((devCommands) => {
          const scannedAt = now();
          return Effect.tryPromise(options.readListeners).pipe(
            Effect.match({
              onFailure: () => ({ facts: [] as ReadonlyArray<PortFact>, listenerWarning: true }),
              onSuccess: (output) => ({
                facts: parseSsListeners(output, scannedAt),
                listenerWarning: false,
              }),
            }),
            Effect.map(({ facts: listenerFacts, listenerWarning }) => {
              const facts = [
                ...devCommands.commands.flatMap((command) => {
                  const fact = configuredPortFact(command);
                  return fact ? [fact] : [];
                }),
                ...listenerFacts,
              ].filter(
                (fact) =>
                  fact.remotePort !== options.controlPort && !RESERVED_PORTS.has(fact.remotePort),
              );
              const result: PortsListResult = {
                projectDir: input.projectDir,
                ...(input.threadId ? { threadId: input.threadId } : {}),
                scannedAt,
                ports: mergePortFacts(facts),
                warnings: [
                  ...devCommands.warnings,
                  ...(listenerWarning ? ["Listener discovery is unavailable."] : []),
                ],
              };
              return result;
            }),
          );
        }),
      ),
  };
}

async function readSsListeners(): Promise<string> {
  const { stdout } = await execFileAsync("ss", ["-ltnpH"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  return stdout;
}

export const GitsPortsLive = Layer.effect(
  GitsPorts,
  Effect.gen(function* () {
    const devCommands = yield* GitsDevCommands;
    const config = yield* ServerConfig;
    return makeGitsPorts({
      controlPort: config.port,
      listDevCommands: devCommands.listCommands,
      readListeners: readSsListeners,
    });
  }),
);

// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GitsMcpInventorySnapshot as GitsMcpInventorySnapshotSchema,
  type GitsMcpAuthStatus,
  type GitsMcpInventorySnapshot,
  type GitsMcpServerItem,
  type GitsMcpServerProvider,
  type GitsMcpServerSource,
  type GitsMcpServerStatus,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  GitsMcpInventoryResolver,
  GitsMcpInventoryResolverError,
  type GitsCodexMcpRuntimeServer,
  type GitsMcpInventoryResolverShape,
} from "../Services/GitsMcpInventory.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";

export interface GitsMcpConfigTarget {
  readonly provider: GitsMcpServerProvider;
  readonly filePath: string;
  readonly format: "toml" | "json";
}

export interface GitsMcpInventoryResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly configTargets?: ReadonlyArray<GitsMcpConfigTarget>;
  readonly now?: () => string;
  readonly maxToolsPerServer?: number;
  readonly getRuntimeServers?: () => Effect.Effect<ReadonlyArray<GitsCodexMcpRuntimeServer>>;
}

interface RawMcpServer {
  readonly provider: GitsMcpServerProvider;
  readonly source: GitsMcpServerSource;
  readonly name: string;
  readonly command: string | null;
  readonly transport: string | null;
  readonly enabled: boolean;
  readonly tools: ReadonlyArray<string>;
  readonly configPath: string;
}

const PROVIDERS: ReadonlyArray<GitsMcpServerProvider> = ["codex", "claude", "cursor"];
const decodeSnapshot = Schema.decodeUnknownSync(GitsMcpInventorySnapshotSchema);

function isNotFoundError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  );
}

function expandHome(rawPath: string, homeDir: string): string {
  if (rawPath === "~") {
    return homeDir;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(homeDir, rawPath.slice(2));
  }
  return rawPath;
}

function cleanText(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  const trimmed = cleanText(value);
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3)}...`;
}

function defaultConfigTargets(env: NodeJS.ProcessEnv, homeDir: string): GitsMcpConfigTarget[] {
  const codexHome = expandHome(env.CODEX_HOME?.trim() || "~/.codex", homeDir);
  const claudeHome = expandHome(env.CLAUDE_HOME?.trim() || "~/.claude", homeDir);
  const cursorHome = expandHome(env.CURSOR_HOME?.trim() || "~/.cursor", homeDir);
  return [
    { provider: "codex", filePath: path.join(codexHome, "config.toml"), format: "toml" },
    { provider: "claude", filePath: path.join(homeDir, ".claude.json"), format: "json" },
    { provider: "claude", filePath: path.join(claudeHome, "settings.json"), format: "json" },
    { provider: "cursor", filePath: path.join(cursorHome, "mcp.json"), format: "json" },
  ];
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (cause) {
    if (isNotFoundError(cause)) {
      return null;
    }
    throw cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function formatCommand(command: unknown, args: unknown): string | null {
  if (typeof command !== "string") {
    return null;
  }
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return null;
  }
  const argList = coerceStringArray(args);
  const joined = [trimmedCommand, ...argList].join(" ");
  return truncate(joined, 4096);
}

function resolveTransport(entry: Record<string, unknown>): string | null {
  const explicitTransport =
    typeof entry.transport === "string" ? entry.transport.trim().toLowerCase() : null;
  if (explicitTransport) {
    return explicitTransport;
  }
  const explicitType = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : null;
  if (explicitType) {
    return explicitType;
  }
  if (typeof entry.url === "string" && entry.url.trim().length > 0) {
    return "http";
  }
  if (typeof entry.command === "string" && entry.command.trim().length > 0) {
    return "stdio";
  }
  return null;
}

function resolveEnabled(entry: Record<string, unknown>): boolean {
  if (typeof entry.disabled === "boolean") {
    return !entry.disabled;
  }
  if (typeof entry.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveCommandOrUrl(entry: Record<string, unknown>): string | null {
  const command = formatCommand(entry.command, entry.args);
  if (command) {
    return command;
  }
  if (typeof entry.url === "string" && entry.url.trim().length > 0) {
    return truncate(entry.url, 4096);
  }
  return null;
}

function parseJsonMcpServers(raw: string, target: GitsMcpConfigTarget): RawMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const mcpServers = parsed.mcpServers;
  if (!isRecord(mcpServers)) {
    return [];
  }
  const servers: RawMcpServer[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (!isRecord(value)) {
      continue;
    }
    servers.push({
      provider: target.provider,
      source: "config-file",
      name,
      command: resolveCommandOrUrl(value),
      transport: resolveTransport(value),
      enabled: resolveEnabled(value),
      tools: [],
      configPath: target.filePath,
    });
  }
  return servers;
}

interface TomlServerTable {
  readonly name: string;
  readonly lines: string[];
}

function collectTomlServerTables(raw: string): TomlServerTable[] {
  const tables: TomlServerTable[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    const headerMatch = line.match(/^\[(?:mcp_servers|mcpServers)\.["']?([^.\]"']+)["']?\]$/);
    if (headerMatch) {
      if (current) {
        tables.push(current);
      }
      current = { name: headerMatch[1] ?? "", lines: [] };
      continue;
    }
    if (line.startsWith("[")) {
      if (current) {
        tables.push(current);
        current = null;
      }
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) {
    tables.push(current);
  }
  return tables.filter((table) => table.name.length > 0);
}

function parseTomlScalar(value: string): string | boolean | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return cleanText(trimmed);
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) {
    return [];
  }
  const inner = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((entry) => cleanText(entry))
    .filter((entry) => entry.length > 0);
}

function parseTomlMcpServers(raw: string, target: GitsMcpConfigTarget): RawMcpServer[] {
  const tables = collectTomlServerTables(raw);
  return tables.map((table) => {
    const entry: Record<string, unknown> = {};
    let args: string[] = [];
    for (const line of table.lines) {
      const keyValueMatch = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
      if (!keyValueMatch) {
        continue;
      }
      const key = keyValueMatch[1]?.toLowerCase() ?? "";
      const rawValue = keyValueMatch[2] ?? "";
      if (key === "args") {
        args = parseTomlStringArray(rawValue);
        entry.args = args;
        continue;
      }
      const scalar = parseTomlScalar(rawValue);
      if (scalar !== null) {
        entry[key] = scalar;
      }
    }
    return {
      provider: target.provider,
      source: "config-file" as const,
      name: table.name,
      command: resolveCommandOrUrl({ ...entry, args }),
      transport: resolveTransport(entry),
      enabled: resolveEnabled(entry),
      tools: [],
      configPath: target.filePath,
    } satisfies RawMcpServer;
  });
}

function toServerItem(raw: RawMcpServer, maxTools: number): GitsMcpServerItem {
  const tools = raw.tools.slice(0, maxTools).map((tool) => truncate(tool, 200));
  const status: GitsMcpServerStatus = raw.enabled ? "unknown" : "disabled";
  const authStatus: GitsMcpAuthStatus = "unknown";
  return {
    id: `${raw.provider}:${raw.name}`,
    provider: raw.provider,
    name: raw.name,
    source: raw.source,
    status,
    authStatus,
    canAuthenticate: false,
    enabled: raw.enabled,
    command: raw.command,
    transport: raw.transport,
    toolCount: raw.tools.length,
    resourceCount: 0,
    tools,
    configPath: raw.configPath,
    error: null,
  };
}

function mapRuntimeAuthStatus(value: unknown): GitsMcpAuthStatus {
  switch (value) {
    case "unsupported":
      return "unsupported";
    case "notLoggedIn":
      return "unauthenticated";
    case "bearerToken":
    case "oAuth":
      return "authenticated";
    default:
      return "unknown";
  }
}

function mergeRuntimeServers(
  servers: GitsMcpServerItem[],
  runtimeServers: ReadonlyArray<GitsCodexMcpRuntimeServer>,
  maxTools: number,
): void {
  const claimedConfigRows = new Set<number>();
  for (const runtime of runtimeServers) {
    const name = cleanText(runtime.name);
    const providerInstanceId = cleanText(runtime.providerInstanceId);
    if (!name || !providerInstanceId) {
      continue;
    }
    const configIndex = servers.findIndex(
      (server, index) =>
        !claimedConfigRows.has(index) && server.provider === "codex" && server.name === name,
    );
    if (configIndex >= 0) {
      claimedConfigRows.add(configIndex);
    }
    const current = configIndex >= 0 ? servers[configIndex] : undefined;
    const tools = runtime.tools
      .filter((tool): tool is string => typeof tool === "string")
      .map((tool) => truncate(tool, 200))
      .filter(Boolean)
      .slice(0, maxTools);
    const authStatus = mapRuntimeAuthStatus(runtime.authStatus);
    const resourceCount = Number.isSafeInteger(runtime.resourceCount)
      ? Math.max(0, runtime.resourceCount)
      : 0;
    const merged: GitsMcpServerItem = {
      id: current?.id ?? `codex:${providerInstanceId}:${name}`,
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make(providerInstanceId),
      name,
      source: current?.source ?? "codex-app-server",
      runtimeSource: "codex-app-server",
      status: "running",
      runtimeStatus: "running",
      authStatus,
      canAuthenticate: authStatus === "unauthenticated",
      enabled: current?.enabled ?? true,
      command: current?.command ?? null,
      transport: current?.transport ?? null,
      toolCount: runtime.tools.length,
      resourceCount,
      tools,
      configPath: current?.configPath ?? null,
      error: null,
    };
    if (configIndex >= 0) {
      servers[configIndex] = merged;
    } else {
      servers.push(merged);
    }
  }
}

function providerSummaries(servers: ReadonlyArray<GitsMcpServerItem>) {
  return PROVIDERS.map((provider) => {
    const providerServers = servers.filter((server) => server.provider === provider);
    return {
      provider,
      serverCount: providerServers.length,
      runningCount: providerServers.filter((server) => server.status === "running").length,
      disabledCount: providerServers.filter((server) => !server.enabled).length,
      toolCount: providerServers.reduce((total, server) => total + server.toolCount, 0),
    };
  }).filter((provider) => provider.serverCount > 0);
}

async function scanTarget(
  target: GitsMcpConfigTarget,
): Promise<{ readonly servers: RawMcpServer[]; readonly warnings: string[] }> {
  const raw = await readOptionalFile(target.filePath);
  if (raw === null) {
    return {
      servers: [],
      warnings: [`Missing ${target.provider} MCP config: ${target.filePath}`],
    };
  }
  try {
    const servers =
      target.format === "toml"
        ? parseTomlMcpServers(raw, target)
        : parseJsonMcpServers(raw, target);
    return { servers, warnings: [] };
  } catch {
    return {
      servers: [],
      warnings: [`Failed to parse ${target.provider} MCP config: ${target.filePath}`],
    };
  }
}

async function buildSnapshot(options: {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDir?: string | undefined;
  readonly configTargets?: ReadonlyArray<GitsMcpConfigTarget> | undefined;
  readonly now: () => string;
  readonly maxToolsPerServer: number;
  readonly runtimeServers: ReadonlyArray<GitsCodexMcpRuntimeServer>;
}): Promise<GitsMcpInventorySnapshot> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const targets = options.configTargets ?? defaultConfigTargets(env, homeDir);
  const scanResults = await Promise.all(targets.map((target) => scanTarget(target)));
  const warnings = scanResults.flatMap((result) => result.warnings);
  const seen = new Set<string>();
  const servers: GitsMcpServerItem[] = [];
  for (const raw of scanResults.flatMap((result) => result.servers)) {
    const item = toServerItem(raw, options.maxToolsPerServer);
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    servers.push(item);
  }
  mergeRuntimeServers(servers, options.runtimeServers, options.maxToolsPerServer);
  servers.sort((left, right) =>
    `${left.provider}:${left.name}`.localeCompare(`${right.provider}:${right.name}`),
  );
  const providers = providerSummaries(servers);
  const snapshot = {
    scannedAt: options.now(),
    servers,
    providers,
    totals: {
      serverCount: servers.length,
      runningCount: servers.filter((server) => server.status === "running").length,
      errorCount: servers.filter((server) => server.status === "error").length,
      disabledCount: servers.filter((server) => !server.enabled).length,
      toolCount: servers.reduce((total, server) => total + server.toolCount, 0),
    },
    warnings: warnings.slice(0, 40),
  };
  return decodeSnapshot(snapshot);
}

export const makeGitsMcpInventoryResolver = (options?: GitsMcpInventoryResolverOptions) =>
  GitsMcpInventoryResolver.of({
    getSnapshot: () =>
      Effect.gen(function* () {
        const scannedAt = options?.now ? options.now() : DateTime.formatIso(yield* DateTime.now);
        const runtimeServers = options?.getRuntimeServers ? yield* options.getRuntimeServers() : [];
        return yield* Effect.tryPromise({
          try: () =>
            buildSnapshot({
              env: options?.env,
              homeDir: options?.homeDir,
              configTargets: options?.configTargets,
              now: () => scannedAt,
              maxToolsPerServer: options?.maxToolsPerServer ?? 200,
              runtimeServers,
            }),
          catch: (cause) =>
            new GitsMcpInventoryResolverError({
              message: "Failed to scan local GITS MCP inventory.",
              cause,
            }),
        });
      }),
  } satisfies GitsMcpInventoryResolverShape);

export const GitsMcpInventoryResolverLive = Layer.effect(
  GitsMcpInventoryResolver,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeGitsMcpInventoryResolver({
      getRuntimeServers: () =>
        registry.listInstances.pipe(
          Effect.flatMap((instances) =>
            Effect.forEach(
              instances.filter(
                (instance) =>
                  instance.driverKind === "codex" &&
                  instance.adapter.listCodexMcpServers !== undefined,
              ),
              (instance) =>
                instance.adapter.listCodexMcpServers!().pipe(
                  Effect.map((servers) =>
                    servers.map((server) => ({
                      ...server,
                      providerInstanceId: instance.instanceId,
                    })),
                  ),
                  Effect.catch(() => Effect.succeed([])),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((groups) => groups.flat()),
        ),
    });
  }),
);

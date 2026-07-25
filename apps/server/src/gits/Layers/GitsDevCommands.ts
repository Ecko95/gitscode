// @effect-diagnostics nodeBuiltinImport:off
import type { Dirent } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  GitsDevCommandError,
  type GitsDevCommand,
  type GitsDevCommandInitInput,
  type GitsDevCommandListInput,
  type GitsDevCommandListResult,
} from "@t3tools/contracts";

import { readTailscaleStatus } from "@t3tools/tailscale";

import { DEFAULT_DEV_BIND_HOST, ServerConfig } from "../../config.ts";
import {
  materializeDevCommandRunner,
  parseAllowedHosts,
  withStrictPortArgs,
} from "../dev-command-runner.ts";
import { GitsDevCommands, type GitsDevCommandsShape } from "../Services/GitsDevCommands.ts";

const ConfigCommandSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.String),
  command: Schema.String,
  port: Schema.optional(Schema.NullOr(Schema.Number)),
  host: Schema.optional(Schema.NullOr(Schema.String)),
  publishOnTailnet: Schema.optional(Schema.Boolean),
  servePort: Schema.optional(Schema.NullOr(Schema.Number)),
});

const ConfigDevSchema = Schema.Struct({
  allowedHosts: Schema.optional(Schema.Array(Schema.String)),
  bindHost: Schema.optional(Schema.NullOr(Schema.String)),
});

const ConfigFileSchema = Schema.Struct({
  dev: Schema.optional(ConfigDevSchema),
  commands: Schema.Array(ConfigCommandSchema),
});
const decodeConfigFile = Schema.decodeUnknownEffect(ConfigFileSchema);
const isGitsDevCommandError = Schema.is(GitsDevCommandError);

type ConfigCommand = typeof ConfigCommandSchema.Type;

type DiscoveryCommand = ConfigCommand;

const CONFIG_CANDIDATES = [".gits/dev-commands.json", "gits.dev-commands.json"] as const;
const ROOT_PACKAGE_JSON = "package.json";
const APPS_DIRECTORY = "apps";

function toDevCommandError(message: string, cause?: unknown) {
  return new GitsDevCommandError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

async function readFirstExistingConfig(projectDir: string) {
  for (const relativePath of CONFIG_CANDIDATES) {
    const absolutePath = Path.join(projectDir, relativePath);
    try {
      const stat = await Fs.stat(absolutePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await Fs.readFile(absolutePath, "utf8");
      return { configPath: absolutePath, raw };
    } catch {
      continue;
    }
  }
  return null;
}

function normalizePort(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  return normalized >= 1 && normalized <= 65_535 ? normalized : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleCaseSegment(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferDiscoveryMetadata(input: {
  readonly key: string;
  readonly packageName: string | null;
}): Pick<
  DiscoveryCommand,
  "id" | "name" | "description" | "port" | "host" | "publishOnTailnet" | "servePort"
> {
  const normalizedKey = input.key.toLowerCase();
  const packageStem =
    input.packageName
      ?.split("/")
      .at(-1)
      ?.replace(/^t3tools-/, "") ??
    normalizedKey.replace(/^dev:?/, "") ??
    "workspace";
  const resourceLabel =
    normalizedKey === "dev" ? "Workspace dev" : `${titleCaseSegment(packageStem)} dev`;
  return {
    id: sanitizeId(normalizedKey === "dev" ? "workspace-dev" : `${packageStem}-dev`),
    name: resourceLabel,
    description:
      normalizedKey === "dev"
        ? "Inferred from root workspace dev script."
        : input.packageName
          ? `Inferred from ${input.packageName} dev script.`
          : `Inferred from ${input.key} package script.`,
    port: null,
    host: null,
    publishOnTailnet: false,
    servePort: null,
  };
}

async function readJsonRecord(absolutePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await Fs.readFile(absolutePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// JSON serialization is an untyped boundary here; the config file is written for humans to edit,
// so it is intentionally pretty-printed rather than encoded through a schema codec.
function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function readScriptsFromPackageJson(json: Record<string, unknown> | null): Record<string, string> {
  const scripts = json?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

async function discoverRootPackageCommands(
  projectDir: string,
): Promise<ReadonlyArray<DiscoveryCommand>> {
  const packageJson = await readJsonRecord(Path.join(projectDir, ROOT_PACKAGE_JSON));
  const scripts = readScriptsFromPackageJson(packageJson);
  const devScriptNames = Object.keys(scripts).filter(
    (key) => key === "dev" || key.startsWith("dev:"),
  );
  return devScriptNames.map((scriptName) => {
    const metadata = inferDiscoveryMetadata({ key: scriptName, packageName: null });
    return {
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      cwd: ".",
      command: `bun run ${scriptName}`,
      port: metadata.port,
      host: metadata.host,
      publishOnTailnet: metadata.publishOnTailnet,
      servePort: metadata.servePort,
    } satisfies DiscoveryCommand;
  });
}

async function discoverAppPackageCommands(
  projectDir: string,
): Promise<ReadonlyArray<DiscoveryCommand>> {
  const appsDirectory = Path.join(projectDir, APPS_DIRECTORY);
  let entries: ReadonlyArray<Dirent<string>>;
  try {
    entries = await Fs.readdir(appsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const commands: DiscoveryCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const relativeCwd = Path.join(APPS_DIRECTORY, entry.name);
    const packageJson = await readJsonRecord(Path.join(projectDir, relativeCwd, ROOT_PACKAGE_JSON));
    const scripts = readScriptsFromPackageJson(packageJson);
    if (typeof scripts.dev !== "string") {
      continue;
    }
    const packageName = typeof packageJson?.name === "string" ? packageJson.name : null;
    const metadata = inferDiscoveryMetadata({ key: "dev", packageName });
    commands.push({
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      cwd: relativeCwd,
      command: packageName ? `bun run --filter=${packageName} dev` : "bun run dev",
      port: metadata.port,
      host: metadata.host,
      publishOnTailnet: metadata.publishOnTailnet,
      servePort: metadata.servePort,
    });
  }
  return commands;
}

async function discoverCommands(projectDir: string): Promise<ReadonlyArray<DiscoveryCommand>> {
  const rootCommands = await discoverRootPackageCommands(projectDir);
  if (rootCommands.length > 0) {
    return rootCommands;
  }
  return discoverAppPackageCommands(projectDir);
}

function uniqueCommands(
  commands: ReadonlyArray<DiscoveryCommand>,
): ReadonlyArray<DiscoveryCommand> {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.id)) {
      return false;
    }
    seen.add(command.id);
    return true;
  });
}

export function buildDevCommandLaunchCommand(input: {
  readonly runnerPath: string;
  readonly command: GitsDevCommand;
  readonly allowedHosts?: ReadonlyArray<string>;
}): string {
  const allowedHosts = input.allowedHosts ?? [];
  const env = [
    ["GITS_DEV_NAME", input.command.name],
    ["GITS_DEV_CWD", input.command.cwd],
    ["GITS_DEV_COMMAND", input.command.command],
    ...(input.command.localPort === null
      ? []
      : [["GITS_DEV_LOCAL_PORT", String(input.command.localPort)] as const]),
    ...(input.command.localHost === null
      ? []
      : [["GITS_DEV_LOCAL_HOST", input.command.localHost] as const]),
    ...(allowedHosts.length === 0
      ? []
      : [["GITS_DEV_ALLOWED_HOSTS", allowedHosts.join(",")] as const]),
    ...(input.command.publishOnTailnet && input.command.servePort !== null
      ? [["GITS_DEV_SERVE_PORT", String(input.command.servePort)] as const]
      : []),
  ] as const;

  return `${env.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} bash ${shellQuote(input.runnerPath)}`;
}

function toPublicCommand(input: {
  readonly configCommand: ConfigCommand;
  readonly projectDir: string;
  readonly runnerPath: string;
  readonly explicit: boolean;
  readonly settings: ResolvedDevSettings;
}): GitsDevCommand {
  const commandId = input.configCommand.id.trim();
  const cwd = normalizeText(input.configCommand.cwd)
    ? Path.resolve(input.projectDir, input.configCommand.cwd!.trim())
    : input.projectDir;
  const localPort = normalizePort(input.configCommand.port ?? null);
  const localHost = normalizeText(input.configCommand.host) ?? input.settings.bindHost;
  const commandText =
    input.explicit && localPort !== null
      ? withStrictPortArgs({
          command: input.configCommand.command,
          host: localHost,
          port: localPort,
        })
      : input.configCommand.command.trim();
  const servePort = normalizePort(input.configCommand.servePort ?? null);
  const publishOnTailnet =
    input.explicit &&
    input.configCommand.publishOnTailnet === true &&
    input.settings.tailscaleServeEnabled &&
    localPort !== null &&
    servePort !== null;
  const command: GitsDevCommand = {
    id: commandId,
    name: input.configCommand.name.trim(),
    description: normalizeText(input.configCommand.description ?? null),
    cwd,
    command: commandText,
    localPort,
    localHost,
    publishOnTailnet,
    servePort: publishOnTailnet ? servePort : null,
    previewUrl:
      publishOnTailnet && input.settings.magicDnsName
        ? `https://${input.settings.magicDnsName}:${servePort}/`
        : null,
    launchCommand: "",
  };
  return {
    ...command,
    launchCommand: buildDevCommandLaunchCommand({
      runnerPath: input.runnerPath,
      command,
      allowedHosts: input.settings.allowedHosts,
    }),
  };
}

interface ResolvedDevSettings {
  readonly allowedHosts: ReadonlyArray<string>;
  readonly bindHost: string;
  readonly tailscaleServeEnabled: boolean;
  readonly magicDnsName: string | null;
}

function resolveDevSettings(input: {
  readonly options: GitsDevCommandsOptions;
  readonly file?: typeof ConfigDevSchema.Type | undefined;
}): ResolvedDevSettings {
  const fileAllowedHosts = parseAllowedHosts(input.file?.allowedHosts);
  return {
    // Project config replaces the server-wide default so a repo can opt out of it.
    allowedHosts:
      fileAllowedHosts.length > 0
        ? fileAllowedHosts
        : parseAllowedHosts(input.options.allowedHosts),
    bindHost:
      normalizeText(input.file?.bindHost ?? null) ??
      input.options.bindHost ??
      DEFAULT_DEV_BIND_HOST,
    tailscaleServeEnabled: input.options.tailscaleServeEnabled ?? false,
    magicDnsName: input.options.magicDnsName ?? null,
  };
}

function tailnetWarnings(input: {
  readonly commands: ReadonlyArray<ConfigCommand>;
  readonly settings: ResolvedDevSettings;
}): ReadonlyArray<string> {
  const requested = input.commands.filter((command) => command.publishOnTailnet === true);
  if (requested.length === 0) return [];
  if (!input.settings.tailscaleServeEnabled) {
    return ["Tailnet publishing is disabled. Set GITS_DEV_TAILSCALE_SERVE=true to enable it."];
  }
  const missingPort = requested.filter(
    (command) => normalizePort(command.servePort ?? null) === null,
  );
  return missingPort.length === 0
    ? []
    : [
        `Tailnet publishing needs an explicit servePort for: ${missingPort
          .map((command) => command.id)
          .join(", ")}.`,
      ];
}

function toConfigCommandForWrite(input: {
  readonly command: DiscoveryCommand;
  readonly projectDir: string;
}): ConfigCommand {
  const cwd = input.command.cwd && input.command.cwd !== "." ? input.command.cwd : undefined;
  return {
    id: input.command.id,
    name: input.command.name,
    ...(input.command.description ? { description: input.command.description } : {}),
    ...(cwd ? { cwd } : {}),
    command: input.command.command,
    ...(input.command.port === null || input.command.port === undefined
      ? {}
      : { port: input.command.port }),
    ...(input.command.host ? { host: input.command.host } : {}),
    ...(input.command.publishOnTailnet ? { publishOnTailnet: true } : {}),
    ...(input.command.servePort === null || input.command.servePort === undefined
      ? {}
      : { servePort: input.command.servePort }),
  };
}

async function buildListResult(
  projectDir: string,
  options: GitsDevCommandsOptions,
): Promise<GitsDevCommandListResult> {
  const runnerPath = options.runnerPath;
  const config = await readFirstExistingConfig(projectDir);

  if (config !== null) {
    const parsedJson = JSON.parse(config.raw) as unknown;
    const parsed = await decodeConfigFile(parsedJson).pipe(Effect.runPromise);
    const settings = resolveDevSettings({ options, file: parsed.dev });
    return {
      projectDir,
      configPath: config.configPath,
      tailscaleAvailable: settings.tailscaleServeEnabled,
      magicDnsName: settings.magicDnsName,
      allowedHosts: settings.allowedHosts,
      bindHost: settings.bindHost,
      commands: parsed.commands.map((command) =>
        toPublicCommand({
          configCommand: command,
          projectDir,
          runnerPath,
          explicit: true,
          settings,
        }),
      ),
      warnings: tailnetWarnings({ commands: parsed.commands, settings }),
    };
  }

  const settings = resolveDevSettings({ options });
  const discovered = uniqueCommands(await discoverCommands(projectDir));
  return {
    projectDir,
    configPath: null,
    tailscaleAvailable: settings.tailscaleServeEnabled,
    magicDnsName: settings.magicDnsName,
    allowedHosts: settings.allowedHosts,
    bindHost: settings.bindHost,
    commands: discovered.map((command) =>
      toPublicCommand({
        configCommand: command,
        projectDir,
        runnerPath,
        explicit: false,
        settings,
      }),
    ),
    warnings:
      discovered.length > 0
        ? [
            `No dev command config found. Using inferred presets from package.json scripts. Initialize ${CONFIG_CANDIDATES[0]} to save them for this repo.`,
          ]
        : [
            `No dev command config found and no dev scripts were discovered. Add ${CONFIG_CANDIDATES[0]} or define package.json dev scripts.`,
          ],
  };
}

export interface GitsDevCommandsOptions {
  readonly runnerPath: string;
  /** Server-wide default hostnames dev servers accept (`GITS_DEV_ALLOWED_HOSTS`). */
  readonly allowedHosts?: ReadonlyArray<string> | string;
  readonly bindHost?: string;
  readonly tailscaleServeEnabled?: boolean;
  readonly magicDnsName?: string | null;
}

export function makeGitsDevCommandsService(options: GitsDevCommandsOptions): GitsDevCommandsShape {
  const listCommands: GitsDevCommandsShape["listCommands"] = (input: GitsDevCommandListInput) =>
    Effect.tryPromise({
      try: () => buildListResult(input.projectDir, options),
      catch: (cause) =>
        toDevCommandError(
          `Failed to inspect or parse dev command config in ${input.projectDir}.`,
          cause,
        ),
    });

  const initCommands: GitsDevCommandsShape["initCommands"] = (input: GitsDevCommandInitInput) =>
    Effect.tryPromise({
      try: async () => {
        const existing = await readFirstExistingConfig(input.projectDir);
        if (existing !== null) {
          return buildListResult(input.projectDir, options);
        }
        const discovered = uniqueCommands(await discoverCommands(input.projectDir));
        if (discovered.length === 0) {
          throw toDevCommandError(
            `No dev scripts were discovered in ${input.projectDir}. Add package.json dev scripts or create ${CONFIG_CANDIDATES[0]} manually.`,
          );
        }
        const configPath = Path.join(input.projectDir, CONFIG_CANDIDATES[0]);
        await Fs.mkdir(Path.dirname(configPath), { recursive: true });
        const file = {
          commands: discovered.map((command) =>
            toConfigCommandForWrite({
              command,
              projectDir: input.projectDir,
            }),
          ),
        } satisfies typeof ConfigFileSchema.Type;
        await Fs.writeFile(configPath, `${toPrettyJson(file)}\n`, "utf8");
        return buildListResult(input.projectDir, options);
      },
      catch: (cause) =>
        isGitsDevCommandError(cause)
          ? cause
          : toDevCommandError(
              `Failed to initialize or parse dev command config in ${input.projectDir}.`,
              cause,
            ),
    });

  return { listCommands, initCommands };
}

export const GitsDevCommandsLive = Layer.effect(
  GitsDevCommands,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const runnerPath = yield* Effect.promise(() => materializeDevCommandRunner(config.stateDir));
    // Read once at boot: the tailnet name is stable for the lifetime of the process.
    const magicDnsName = config.devTailscaleServeEnabled
      ? yield* readTailscaleStatus.pipe(
          Effect.map((status) => status.magicDnsName),
          Effect.catchCause(() => Effect.succeed(null)),
        )
      : null;
    return makeGitsDevCommandsService({
      runnerPath,
      allowedHosts: config.devAllowedHosts,
      bindHost: config.devBindHost,
      tailscaleServeEnabled: config.devTailscaleServeEnabled,
      magicDnsName,
    });
  }),
);

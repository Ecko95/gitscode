// @effect-diagnostics nodeBuiltinImport:off
import type { Dirent } from "node:fs";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
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
import { resolveTailscaleHttpsBaseUrl } from "@t3tools/tailscale";

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

const ConfigFileSchema = Schema.Struct({
  commands: Schema.Array(ConfigCommandSchema),
});

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

function normalizeInteger(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
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

function inferPortHint(value: string): number | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("marketing")) {
    return 4321;
  }
  if (normalized.includes("storybook")) {
    return 6006;
  }
  if (
    normalized.includes("web") ||
    normalized.includes("vite") ||
    normalized.includes("ui") ||
    normalized.includes("frontend")
  ) {
    return 3000;
  }
  return null;
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
  const port = inferPortHint(`${normalizedKey} ${input.packageName ?? ""}`);
  return {
    id: sanitizeId(normalizedKey === "dev" ? "workspace-dev" : `${packageStem}-dev`),
    name: resourceLabel,
    description:
      normalizedKey === "dev"
        ? "Inferred from root workspace dev script."
        : input.packageName
          ? `Inferred from ${input.packageName} dev script.`
          : `Inferred from ${input.key} package script.`,
    port,
    host: port === null ? null : "127.0.0.1",
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
  readonly wrapperPath: string;
  readonly command: GitsDevCommand;
}): string {
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
    ["GITS_DEV_PUBLISH_TAILNET", input.command.publishOnTailnet ? "1" : "0"],
    ...(input.command.servePort === null
      ? []
      : [["GITS_DEV_SERVE_PORT", String(input.command.servePort)] as const]),
    ...(input.command.previewUrl === null
      ? []
      : [["GITS_DEV_PREVIEW_URL", input.command.previewUrl] as const]),
  ] as const;

  return `${env.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} bash ${shellQuote(input.wrapperPath)}`;
}

function buildPreviewUrl(input: {
  readonly magicDnsName: string | null;
  readonly servePort: number | null;
}) {
  if (!input.magicDnsName || input.servePort === null) {
    return null;
  }
  const url = new URL(`https://${input.magicDnsName}`);
  if (input.servePort !== 443) {
    url.port = String(input.servePort);
  }
  url.pathname = "/";
  return url.toString();
}

function toPublicCommand(input: {
  readonly configCommand: ConfigCommand;
  readonly projectDir: string;
  readonly wrapperPath: string;
  readonly magicDnsName: string | null;
}): GitsDevCommand {
  const commandId = input.configCommand.id.trim();
  const cwd = normalizeText(input.configCommand.cwd)
    ? Path.resolve(input.projectDir, input.configCommand.cwd!.trim())
    : input.projectDir;
  const localPort = normalizeInteger(input.configCommand.port ?? null);
  const localHost =
    normalizeText(input.configCommand.host) ?? (localPort === null ? null : "127.0.0.1");
  const publishOnTailnet = input.configCommand.publishOnTailnet === true;
  const servePort = publishOnTailnet
    ? normalizeInteger(input.configCommand.servePort ?? localPort)
    : null;
  const previewUrl = publishOnTailnet
    ? buildPreviewUrl({ magicDnsName: input.magicDnsName, servePort })
    : null;
  const command: GitsDevCommand = {
    id: commandId,
    name: input.configCommand.name.trim(),
    description: normalizeText(input.configCommand.description ?? null),
    cwd,
    command: input.configCommand.command.trim(),
    localPort,
    localHost,
    publishOnTailnet,
    servePort,
    previewUrl,
    launchCommand: "",
  };
  return {
    ...command,
    launchCommand: buildDevCommandLaunchCommand({
      wrapperPath: input.wrapperPath,
      command,
    }),
  };
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

async function resolveRuntimeContext() {
  const tailscaleBaseUrl = await resolveTailscaleHttpsBaseUrl().pipe(
    Effect.map((url) => url),
    Effect.catchTags({
      TailscaleCommandError: () => Effect.succeed<string | null>(null),
      TailscaleStatusParseError: () => Effect.succeed<string | null>(null),
    }),
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );
  const magicDnsName = tailscaleBaseUrl ? new URL(tailscaleBaseUrl).hostname : null;
  return {
    magicDnsName,
    tailscaleAvailable: magicDnsName !== null,
  };
}

async function buildListResult(projectDir: string): Promise<GitsDevCommandListResult> {
  const config = await readFirstExistingConfig(projectDir);
  const runtime = await resolveRuntimeContext();
  const wrapperPath = Path.join(projectDir, "scripts", "dev", "run-dev-command.sh");

  if (config !== null) {
    const parsedJson = JSON.parse(config.raw) as unknown;
    const parsed = await Schema.decodeUnknownEffect(ConfigFileSchema)(parsedJson).pipe(
      Effect.runPromise,
    );
    return {
      projectDir,
      configPath: config.configPath,
      tailscaleAvailable: runtime.tailscaleAvailable,
      magicDnsName: runtime.magicDnsName,
      commands: parsed.commands.map((command) =>
        toPublicCommand({
          configCommand: command,
          projectDir,
          wrapperPath,
          magicDnsName: runtime.magicDnsName,
        }),
      ),
      warnings: [],
    };
  }

  const discovered = uniqueCommands(await discoverCommands(projectDir));
  return {
    projectDir,
    configPath: null,
    tailscaleAvailable: runtime.tailscaleAvailable,
    magicDnsName: runtime.magicDnsName,
    commands: discovered.map((command) =>
      toPublicCommand({
        configCommand: command,
        projectDir,
        wrapperPath,
        magicDnsName: runtime.magicDnsName,
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

const makeListCommands: GitsDevCommandsShape["listCommands"] = (input: GitsDevCommandListInput) =>
  Effect.tryPromise({
    try: () => buildListResult(input.projectDir),
    catch: (cause) =>
      toDevCommandError(
        `Failed to inspect or parse dev command config in ${input.projectDir}.`,
        cause,
      ),
  });

const makeInitCommands: GitsDevCommandsShape["initCommands"] = (input: GitsDevCommandInitInput) =>
  Effect.tryPromise({
    try: async () => {
      const existing = await readFirstExistingConfig(input.projectDir);
      if (existing !== null) {
        return buildListResult(input.projectDir);
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
      return buildListResult(input.projectDir);
    },
    catch: (cause) =>
      Schema.is(GitsDevCommandError)(cause)
        ? cause
        : toDevCommandError(
            `Failed to initialize or parse dev command config in ${input.projectDir}.`,
            cause,
          ),
  });

export const makeGitsDevCommands = Effect.succeed({
  listCommands: makeListCommands,
  initCommands: makeInitCommands,
} satisfies GitsDevCommandsShape);

export const GitsDevCommandsLive = Layer.effect(GitsDevCommands, makeGitsDevCommands);

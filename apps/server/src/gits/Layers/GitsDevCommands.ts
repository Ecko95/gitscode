import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  GitsDevCommandError,
  type GitsDevCommand,
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

const CONFIG_CANDIDATES = [".gits/dev-commands.json", "gits.dev-commands.json"] as const;

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

function buildPreviewUrl(input: { readonly magicDnsName: string | null; readonly servePort: number | null }) {
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
  const localHost = normalizeText(input.configCommand.host) ?? (localPort === null ? null : "127.0.0.1");
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

const makeListCommands: GitsDevCommandsShape["listCommands"] = (input: GitsDevCommandListInput) =>
  Effect.gen(function* () {
    const config = yield* Effect.tryPromise({
      try: () => readFirstExistingConfig(input.projectDir),
      catch: (cause) => toDevCommandError(`Failed to inspect dev command config in ${input.projectDir}.`, cause),
    });

    const tailscaleBaseUrl = yield* resolveTailscaleHttpsBaseUrl().pipe(
      Effect.map((url) => url),
      Effect.catchTag("TailscaleCommandError", () => Effect.succeed<string | null>(null)),
      Effect.catchTag("TailscaleStatusParseError", () => Effect.succeed<string | null>(null)),
    );
    const magicDnsName = tailscaleBaseUrl ? new URL(tailscaleBaseUrl).hostname : null;

    if (config === null) {
      return {
        projectDir: input.projectDir,
        configPath: null,
        tailscaleAvailable: magicDnsName !== null,
        magicDnsName,
        commands: [],
        warnings: [
          `No dev command config found. Add ${CONFIG_CANDIDATES[0]} to this repo to enable launcher presets.`,
        ],
      } satisfies GitsDevCommandListResult;
    }

    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(config.raw) as unknown,
      catch: (cause) =>
        toDevCommandError(`Failed to parse dev command config JSON at ${config.configPath}.`, cause),
    });

    const parsed = yield* Schema.decodeUnknown(ConfigFileSchema)(parsedJson).pipe(
      Effect.mapError((cause) =>
        toDevCommandError(`Failed to parse dev command config at ${config.configPath}.`, cause),
      ),
    );

    const wrapperPath = Path.join(input.projectDir, "scripts", "dev", "run-dev-command.sh");
    const commands = parsed.commands.map((command) =>
      toPublicCommand({
        configCommand: command,
        projectDir: input.projectDir,
        wrapperPath,
        magicDnsName,
      }),
    );

    return {
      projectDir: input.projectDir,
      configPath: config.configPath,
      tailscaleAvailable: magicDnsName !== null,
      magicDnsName,
      commands,
      warnings: [],
    } satisfies GitsDevCommandListResult;
  });

export const makeGitsDevCommands = Effect.succeed({
  listCommands: makeListCommands,
} satisfies GitsDevCommandsShape);

export const GitsDevCommandsLive = Layer.effect(GitsDevCommands, makeGitsDevCommands);

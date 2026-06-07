import type { RemoteAgentRecord, RemoteSshTarget } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { SshPasswordPrompt } from "@t3tools/ssh/auth";
import { resolveRemoteT3CliPackageSpec, resolveSshTarget } from "@t3tools/ssh/command";
import {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  type RemoteT3RunnerOptions,
  stopRemoteServer,
  waitForHttpReady,
} from "@t3tools/ssh/tunnel";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import packageJson from "../../package.json" with { type: "json" };
import { ServerConfig } from "../config.ts";
import {
  RemoteAgentRegistry,
  RemoteAgentRegistryLive,
  type RemoteAgentRegistryShape,
} from "../remote/RemoteAgentRegistry.ts";
import {
  formatRemoteAgentAddedJson,
  formatRemoteAgentList,
  formatRemoteAgentMissingJson,
  formatRemoteAgentRemovedJson,
  formatRemoteAgentStatusJson,
} from "../cliRemoteFormat.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Full service surface a `t3 remote` handler can read. NodeServices (provided by
 * bin.ts) supplies ChildProcessSpawner/FileSystem/Path/Crypto ambiently; the
 * local layer in runWithRemoteRegistry adds HttpClient, NetService and the no-op
 * SshPasswordPrompt, so those are subtracted from the residual after provide.
 */
type RemoteCliRunContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | HttpClient.HttpClient
  | NetService.NetService;

const READINESS_TIMEOUT_MS = 10_000;

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const userFlag = Flag.string("user").pipe(
  Flag.withDescription("SSH username override (defaults to the resolved SSH config user)."),
  Flag.optional,
);

const sshPortFlag = Flag.integer("port").pipe(
  Flag.withDescription("SSH port override (defaults to the resolved SSH config port)."),
  Flag.optional,
);

const noPairFlag = Flag.boolean("no-pair").pipe(
  Flag.withDescription("Provision/reuse the remote agent without issuing a pairing credential."),
  Flag.withDefault(false),
);

/**
 * The headless CLI uses the published `t3` package on the remote host, pinned to
 * this server's version when it looks publishable, mirroring the desktop's
 * stable-channel runner resolution in apps/desktop/src/main.ts.
 */
const resolveCliRunnerOptions = (): RemoteT3RunnerOptions => ({
  packageSpec: resolveRemoteT3CliPackageSpec({
    appVersion: packageJson.version,
    updateChannel: "latest",
  }),
  nodeEngineRange: packageJson.engines.node,
});

/**
 * Non-interactive SSH only. A headless box should use key-based auth; if a
 * password is required we fail fast rather than block on a TTY prompt. The
 * engine still requires the SshPasswordPrompt service in its context, so we
 * provide the disabled (no-op) layer to satisfy it without desktop deps.
 */
const RemoteCliRuntimeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  NetService.layer,
  SshPasswordPrompt.disabledLayer,
);

const runWithRemoteRegistry = <A, E>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  run: (registry: RemoteAgentRegistryShape) => Effect.Effect<A, E, RemoteCliRunContext>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = flags.json ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const registry = yield* RemoteAgentRegistry;
      return yield* run(registry);
    }).pipe(
      Effect.provide(
        RemoteAgentRegistryLive.pipe(
          Layer.provideMerge(RemoteCliRuntimeLayer),
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

const remoteAgentUuid = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));

const remoteBaseUrls = (remotePort: number) => {
  const httpBaseUrl = `http://127.0.0.1:${remotePort}`;
  return {
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
  };
};

const applyTargetOverrides = (
  target: RemoteSshTarget,
  overrides: { readonly user: Option.Option<string>; readonly port: Option.Option<number> },
): RemoteSshTarget => ({
  ...target,
  username: Option.getOrElse(overrides.user, () => target.username),
  port: Option.getOrElse(overrides.port, () => target.port),
});

const remoteAddCommand = Command.make("add", {
  ...projectLocationFlags,
  alias: Argument.string("ssh-target").pipe(
    Argument.withDescription("SSH host alias or user@hostname to provision a remote agent on."),
  ),
  user: userFlag,
  port: sshPortFlag,
  noPair: noPairFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Provision or reuse a remote T3 agent over SSH and save it."),
  Command.withHandler((flags) =>
    runWithRemoteRegistry(flags, (registry) =>
      Effect.gen(function* () {
        const runner = resolveCliRunnerOptions();
        const resolved = yield* resolveSshTarget(flags.alias);
        const target = applyTargetOverrides(resolved, { user: flags.user, port: flags.port });

        const launch = yield* launchOrReuseRemoteServer(target, { batchMode: "yes" }, runner);
        const { httpBaseUrl, wsBaseUrl } = remoteBaseUrls(launch.remotePort);

        const credential = flags.noPair
          ? null
          : (yield* issueRemotePairingToken(target, { batchMode: "yes" }, runner)).credential;

        const existing = yield* registry.find(target.alias);
        const id = existing?.id ?? (yield* remoteAgentUuid);
        const now = DateTime.formatIso(yield* DateTime.now);
        const record: RemoteAgentRecord = {
          id,
          alias: target.alias,
          target,
          httpBaseUrl,
          wsBaseUrl,
          remoteServerKind: launch.remoteServerKind,
          createdAt: existing?.createdAt ?? now,
          lastSeenAt: now,
        };
        yield* registry.upsert(record);

        if (flags.json) {
          yield* Console.log(formatRemoteAgentAddedJson({ record, pairingToken: credential }));
          return;
        }

        const pairUrl = credential
          ? (() => {
              const url = new URL("/pair", httpBaseUrl);
              url.hash = new URLSearchParams([["token", credential]]).toString();
              return url.toString();
            })()
          : null;
        yield* Console.log(
          [
            `Saved remote agent ${record.alias} (${record.id}).`,
            `Reachable at: ${httpBaseUrl}`,
            ...(credential ? [`Pairing token: ${credential}`, `Pairing URL: ${pairUrl}`] : []),
            "",
            "The remote agent listens on its own loopback interface. Reach it directly over",
            "Tailnet/LAN/HTTPS (see REMOTE.md), or run `t3 serve --tailscale-serve` there.",
            "If launch failed with a node version error, see the SSH Launch Troubleshooting",
            "section of REMOTE.md.",
            "",
          ].join("\n"),
        );
      }),
    ),
  ),
);

const remoteListCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List saved remote agents without pairing secrets."),
  Command.withHandler((flags) =>
    runWithRemoteRegistry(flags, (registry) =>
      Effect.gen(function* () {
        const agents = yield* registry.list();
        yield* Console.log(formatRemoteAgentList(agents, { json: flags.json }));
      }),
    ),
  ),
);

const remoteStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  identifier: Argument.string("id-or-alias").pipe(
    Argument.withDescription("Saved remote agent id or alias to probe."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Probe a saved remote agent's reachability."),
  Command.withHandler((flags) =>
    runWithRemoteRegistry(flags, (registry) =>
      Effect.gen(function* () {
        const record = yield* registry.find(flags.identifier);
        if (record === null) {
          yield* Console.log(
            flags.json
              ? formatRemoteAgentMissingJson({ identifier: flags.identifier, field: "found" })
              : `No saved remote agent found for '${flags.identifier}'.\n`,
          );
          return;
        }

        const readyExit = yield* Effect.exit(
          waitForHttpReady({ baseUrl: record.httpBaseUrl, timeoutMs: READINESS_TIMEOUT_MS }),
        );
        const reachable = Exit.isSuccess(readyExit);

        if (flags.json) {
          yield* Console.log(formatRemoteAgentStatusJson({ record, reachable }));
          return;
        }
        yield* Console.log(
          `${record.alias} (${record.id}) at ${record.httpBaseUrl} is ${
            reachable ? "reachable" : "not reachable from this host"
          }.\n`,
        );
      }),
    ),
  ),
);

const remoteRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  identifier: Argument.string("id-or-alias").pipe(
    Argument.withDescription("Saved remote agent id or alias to remove."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Stop a remote managed agent (best-effort) and drop its saved record."),
  Command.withHandler((flags) =>
    runWithRemoteRegistry(flags, (registry) =>
      Effect.gen(function* () {
        const record = yield* registry.find(flags.identifier);
        if (record === null) {
          yield* Console.log(
            flags.json
              ? formatRemoteAgentMissingJson({ identifier: flags.identifier, field: "removed" })
              : `No saved remote agent found for '${flags.identifier}'.\n`,
          );
          return;
        }

        yield* stopRemoteServer(record.target, { batchMode: "yes" }).pipe(Effect.ignore);
        const removed = yield* registry.remove(record.id);

        if (flags.json) {
          yield* Console.log(formatRemoteAgentRemovedJson({ record, removed }));
          return;
        }
        yield* Console.log(`Removed remote agent ${record.alias} (${record.id}).\n`);
      }),
    ),
  ),
);

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription(
    "Provision and manage remote T3 agents over SSH from a headless control plane.",
  ),
  Command.withSubcommands([
    remoteAddCommand,
    remoteListCommand,
    remoteStatusCommand,
    remoteRemoveCommand,
  ]),
);

import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshForwardReleaseInput,
  DesktopSshForwardRequest,
  DesktopSshForwardResult,
  DesktopSshOpenRemoteUrlError,
  DesktopSshOpenRemoteUrlInput,
  DesktopSshOpenRemoteUrlResult,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import {
  classifyEnvironmentUrl,
  extractLoopbackRedirectUri,
  rewriteLoopbackOrigin,
} from "@t3tools/shared/environmentUrl";
import {
  SshPasswordPrompt,
  type SshPasswordPromptShape,
  type SshPasswordRequest,
} from "@t3tools/ssh/auth";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import { SshEnvironmentManager, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export type DesktopSshEnvironmentError =
  | DesktopSshEnvironmentDiscoverError
  | DesktopSshEnvironmentOperationError;

export interface DesktopSshEnvironmentShape {
  readonly discoverHosts: (input?: {
    readonly homeDir?: string;
  }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  readonly ensureForward: (
    target: DesktopSshEnvironmentTarget,
    input: DesktopSshForwardRequest,
  ) => Effect.Effect<DesktopSshForwardResult, DesktopSshEnvironmentOperationError>;
  readonly releaseForward: (
    target: DesktopSshEnvironmentTarget,
    input: DesktopSshForwardReleaseInput,
  ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  readonly openRemoteUrl: (
    input: DesktopSshOpenRemoteUrlInput,
  ) => Effect.Effect<DesktopSshOpenRemoteUrlResult>;
}

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  DesktopSshEnvironmentShape
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPromptsShape,
): SshPasswordPromptShape => ({
  isAvailable: true,
  request: (request: SshPasswordRequest) =>
    prompts.request(request).pipe(
      Effect.mapError(
        (cause) =>
          new SshPasswordPromptError({
            message: cause.message,
            cause,
          }),
      ),
    ),
});

function urlPort(url: URL): number {
  if (url.port) return Number.parseInt(url.port, 10);
  return url.protocol === "https:" ? 443 : 80;
}

function hasEmbeddedCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

const openError = (error: DesktopSshOpenRemoteUrlError): DesktopSshOpenRemoteUrlResult => ({
  opened: false,
  error,
});

const make = Effect.gen(function* () {
  const manager = yield* SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const electronShell = yield* ElectronShell.ElectronShell;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshPasswordPrompt.of(makePasswordPrompt(prompts));

  const ensureForward = (target: DesktopSshEnvironmentTarget, input: DesktopSshForwardRequest) =>
    manager
      .ensureForward(target, input)
      .pipe(
        Effect.provideService(SshPasswordPrompt, passwordPrompt),
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.ensureForward"),
      );

  const openRemoteUrl = Effect.fn("desktop.ssh.openRemoteUrl")(function* (
    input: DesktopSshOpenRemoteUrlInput,
  ): Effect.fn.Return<DesktopSshOpenRemoteUrlResult> {
    const parsed = yield* Effect.result(
      Effect.try({
        try: () => classifyEnvironmentUrl(input.url),
        catch: () => undefined,
      }),
    );
    if (Result.isFailure(parsed)) return openError("invalid-url");
    const classified = parsed.success;
    if (hasEmbeddedCredentials(classified.url)) return openError("invalid-url");

    const redirect = extractLoopbackRedirectUri(classified.url);
    if (redirect && hasEmbeddedCredentials(redirect)) return openError("invalid-url");
    const extractedRedirectPort = redirect ? urlPort(redirect) : null;
    if (
      input.oauthRedirectPort !== undefined &&
      extractedRedirectPort !== null &&
      input.oauthRedirectPort !== extractedRedirectPort
    ) {
      return openError("invalid-url");
    }
    const oauthPort = input.oauthRedirectPort ?? extractedRedirectPort;
    if (
      oauthPort !== undefined &&
      oauthPort !== null &&
      classified.kind === "loopback" &&
      urlPort(classified.url) !== oauthPort
    ) {
      return openError("invalid-url");
    }

    if (oauthPort !== undefined && oauthPort !== null) {
      const forward = yield* Effect.result(
        ensureForward(input.target, {
          remoteHost: "127.0.0.1",
          remotePort: oauthPort,
          policy: { kind: "exact", localPort: oauthPort },
        }),
      );
      if (Result.isFailure(forward)) {
        if (isDesktopSshPasswordPromptCancellation(forward.failure)) {
          return openError("authentication-cancelled");
        }
        return openError(
          forward.failure instanceof SshReadinessError
            ? "local-port-unavailable"
            : "forward-failed",
        );
      }
      const opened = yield* electronShell.openExternal(input.url);
      return opened
        ? {
            opened: true,
            kind: "oauth-forward",
            remotePort: oauthPort,
            localPort: forward.success.localPort,
          }
        : openError("open-failed");
    }

    if (classified.kind === "external") {
      return (yield* electronShell.openExternal(input.url))
        ? { opened: true, kind: "external" }
        : openError("open-failed");
    }

    const remotePort = urlPort(classified.url);
    const forward = yield* Effect.result(
      ensureForward(input.target, {
        remoteHost: "127.0.0.1",
        remotePort,
        policy: { kind: "flexible" },
      }),
    );
    if (Result.isFailure(forward)) {
      return openError(
        isDesktopSshPasswordPromptCancellation(forward.failure)
          ? "authentication-cancelled"
          : "forward-failed",
      );
    }
    const rewrittenUrl = rewriteLoopbackOrigin({
      url: classified.url,
      localPort: forward.success.localPort,
    });
    return (yield* electronShell.openExternal(rewrittenUrl.toString()))
      ? {
          opened: true,
          kind: "direct-forward",
          remotePort,
          localPort: forward.success.localPort,
        }
      : openError("open-failed");
  });

  return DesktopSshEnvironment.of({
    discoverHosts: (input) =>
      discoverDesktopSshHostsEffect(input).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.discoverHosts"),
      ),
    ensureEnvironment: (target, ensureOptions) =>
      manager
        .ensureEnvironment(target, ensureOptions)
        .pipe(
          Effect.provideService(SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.ensureEnvironment"),
        ),
    disconnectEnvironment: (target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(
          Effect.provideService(SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.disconnectEnvironment"),
        ),
    ensureForward,
    releaseForward: (target, input) =>
      manager
        .releaseForward(target, input)
        .pipe(
          Effect.provideService(SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.releaseForward"),
        ),
    openRemoteUrl,
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );

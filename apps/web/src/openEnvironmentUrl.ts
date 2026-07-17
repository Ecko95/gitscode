import type {
  DesktopSshEnvironmentTarget,
  DesktopSshOpenRemoteUrlError,
  DesktopSshOpenRemoteUrlInput,
  DesktopSshOpenRemoteUrlResult,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { classifyEnvironmentUrl } from "@t3tools/shared/environmentUrl";

import { readEnvironmentBrowserPreviewApi } from "./environmentApi";
import { getSavedEnvironmentRecord } from "./environments/runtime";
import { openDesktopSshUrl, readLocalApi } from "./localApi";

interface BrowserPreviewApi {
  readonly open: (input: {
    readonly threadId: ThreadId;
  }) => Promise<{ previewPath: string | null }>;
  readonly control: (input: {
    readonly threadId: ThreadId;
    readonly action: "navigate";
    readonly url: string;
  }) => Promise<{ previewPath: string | null }>;
}

export interface OpenEnvironmentUrlDependencies {
  readonly getRemoteEnvironment: (environmentId: EnvironmentId) => {
    readonly httpBaseUrl: string;
    readonly desktopSsh?: DesktopSshEnvironmentTarget | undefined;
  } | null;
  readonly getBrowserPreview: (environmentId: EnvironmentId) => BrowserPreviewApi | undefined;
  readonly openDesktopSshUrl: (
    input: DesktopSshOpenRemoteUrlInput,
  ) => Promise<DesktopSshOpenRemoteUrlResult>;
  readonly openExternal: (url: string) => Promise<void>;
}

const defaultDependencies: OpenEnvironmentUrlDependencies = {
  getRemoteEnvironment: getSavedEnvironmentRecord,
  getBrowserPreview: readEnvironmentBrowserPreviewApi,
  openDesktopSshUrl,
  openExternal: (url) => {
    const localApi = readLocalApi();
    return localApi
      ? localApi.shell.openExternal(url)
      : Promise.reject(new Error("Opening links is unavailable in this browser."));
  },
};

const desktopSshOpenErrorMessages: Record<DesktopSshOpenRemoteUrlError, string> = {
  "invalid-url": "The link is invalid.",
  "local-port-unavailable": "The required local callback port is already in use.",
  "authentication-cancelled": "SSH authentication was cancelled.",
  "forward-failed": "Unable to create the SSH port forward.",
  "open-failed": "Unable to open link.",
};

export function resolveEnvironmentPreviewUrl(httpBaseUrl: string, previewPath: string): string {
  return new URL(previewPath, httpBaseUrl).toString();
}

export async function openEnvironmentUrl(
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly url: string;
    readonly source: "terminal";
  },
  dependencies: OpenEnvironmentUrlDependencies = defaultDependencies,
): Promise<void> {
  const classified = classifyEnvironmentUrl(input.url);
  const remote = dependencies.getRemoteEnvironment(input.environmentId);
  if (!remote || classified.kind === "external") {
    await dependencies.openExternal(input.url);
    return;
  }
  if (remote.desktopSsh) {
    const result = await dependencies.openDesktopSshUrl({
      target: remote.desktopSsh,
      url: input.url,
    });
    if (!result.opened) {
      throw new Error(desktopSshOpenErrorMessages[result.error]);
    }
    return;
  }
  if (classified.kind === "oauth-loopback") {
    throw new Error("A remote loopback callback cannot be reached by this browser-only client.");
  }

  const browserPreview = dependencies.getBrowserPreview(input.environmentId);
  if (!browserPreview) throw new Error("The environment browser is unavailable.");
  await browserPreview.open({ threadId: input.threadId });
  const status = await browserPreview.control({
    threadId: input.threadId,
    action: "navigate",
    url: classified.url.toString(),
  });
  if (!status.previewPath) throw new Error("The environment browser did not return a viewer URL.");
  await dependencies.openExternal(
    resolveEnvironmentPreviewUrl(remote.httpBaseUrl, status.previewPath),
  );
}

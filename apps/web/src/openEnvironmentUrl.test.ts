import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";

import { openEnvironmentUrl, resolveEnvironmentPreviewUrl } from "./openEnvironmentUrl";

const environmentId = EnvironmentId.make("environment-remote");
const threadId = ThreadId.make("thread-remote");
const desktopSsh = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 22,
} as const;

it("resolves preview paths against the selected environment backend", () => {
  expect(
    resolveEnvironmentPreviewUrl(
      "https://vps.example.test/base/",
      "/api/browser-preview/view?ticket=one",
    ),
  ).toBe("https://vps.example.test/api/browser-preview/view?ticket=one");
});

function harness(remote: boolean, desktop = false) {
  const openExternal = vi.fn(async (_url: string) => undefined);
  const openDesktopSshUrl = vi.fn(async () => ({
    opened: true as const,
    kind: "direct-forward" as const,
    remotePort: 5173,
    localPort: 43_001,
  }));
  const open = vi.fn(async () => ({ previewPath: "/api/browser-preview/view?ticket=first" }));
  const control = vi.fn(async () => ({ previewPath: "/api/browser-preview/view?ticket=second" }));
  return {
    openExternal,
    openDesktopSshUrl,
    open,
    control,
    dependencies: {
      getRemoteEnvironment: () =>
        remote
          ? {
              httpBaseUrl: "https://vps.example.test/base/",
              ...(desktop ? { desktopSsh } : {}),
            }
          : null,
      getBrowserPreview: () => ({ open, control }),
      openDesktopSshUrl,
      openExternal,
    },
  };
}

it("opens public and local-environment URLs unchanged", async () => {
  const remote = harness(true);
  await openEnvironmentUrl(
    { environmentId, threadId, url: "https://example.com/docs", source: "terminal" },
    remote.dependencies,
  );
  expect(remote.openExternal).toHaveBeenCalledWith("https://example.com/docs");
  expect(remote.open).not.toHaveBeenCalled();

  const local = harness(false);
  await openEnvironmentUrl(
    { environmentId, threadId, url: "http://localhost:5173/path", source: "terminal" },
    local.dependencies,
  );
  expect(local.openExternal).toHaveBeenCalledWith("http://localhost:5173/path");
  expect(local.open).not.toHaveBeenCalled();
});

it("opens a remote loopback URL through the selected environment browser", async () => {
  const remote = harness(true);
  await openEnvironmentUrl(
    {
      environmentId,
      threadId,
      url: "http://0.0.0.0:5173/path?q=1#x",
      source: "terminal",
    },
    remote.dependencies,
  );

  expect(remote.open).toHaveBeenCalledWith({ threadId });
  expect(remote.control).toHaveBeenCalledWith({
    threadId,
    action: "navigate",
    url: "http://127.0.0.1:5173/path?q=1#x",
  });
  expect(remote.openExternal).toHaveBeenCalledWith(
    "https://vps.example.test/api/browser-preview/view?ticket=second",
  );
  expect(remote.openDesktopSshUrl).not.toHaveBeenCalled();
});

it("opens a Desktop SSH loopback URL through the atomic desktop action", async () => {
  const remote = harness(true, true);
  await openEnvironmentUrl(
    {
      environmentId,
      threadId,
      url: "http://localhost:5173/path?q=1#x",
      source: "terminal",
    },
    remote.dependencies,
  );

  expect(remote.openDesktopSshUrl).toHaveBeenCalledWith({
    target: desktopSsh,
    url: "http://localhost:5173/path?q=1#x",
  });
  expect(remote.open).not.toHaveBeenCalled();
  expect(remote.openExternal).not.toHaveBeenCalled();
});

it("rejects remote OAuth loopback callbacks that the browser cannot reach", async () => {
  const remote = harness(true);
  await expect(
    openEnvironmentUrl(
      {
        environmentId,
        threadId,
        url: "https://provider.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback",
        source: "terminal",
      },
      remote.dependencies,
    ),
  ).rejects.toThrow(/callback.*browser/i);
  expect(remote.openDesktopSshUrl).not.toHaveBeenCalled();
  expect(remote.openExternal).not.toHaveBeenCalled();
});

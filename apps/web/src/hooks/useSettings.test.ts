import type { LocalApi } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localApiMock = vi.hoisted(() => ({
  current: null as LocalApi | null,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => {
    if (!localApiMock.current) {
      throw new Error("Local API mock was not configured");
    }
    return localApiMock.current;
  },
}));

import {
  __resetClientSettingsPersistenceForTests,
  getClientSettings,
  updateSettings,
} from "./useSettings";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function clientSettings(patch: Partial<ClientSettings> = {}): ClientSettings {
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    ...patch,
  };
}

function installLocalApi(
  persistence: Pick<LocalApi["persistence"], "getClientSettings" | "setClientSettings">,
): void {
  // ponytail: settings hydration tests only touch persistence; stubbing the full LocalApi adds noise.
  localApiMock.current = {
    persistence,
  } as unknown as LocalApi;
}

describe("useSettings client persistence", () => {
  beforeEach(() => {
    __resetClientSettingsPersistenceForTests();
    localApiMock.current = null;
  });

  afterEach(() => {
    __resetClientSettingsPersistenceForTests();
    localApiMock.current = null;
  });

  it("merges a pre-hydration client write onto hydrated settings before persisting", async () => {
    const hydration = deferred<ClientSettings | null>();
    const persistedSettings = clientSettings({
      diffWordWrap: true,
      timestampFormat: "24-hour",
    });
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    installLocalApi({
      getClientSettings: vi.fn(() => hydration.promise),
      setClientSettings,
    });

    const updatePromise = updateSettings({ diffIgnoreWhitespace: false });
    await Promise.resolve();

    expect(setClientSettings).not.toHaveBeenCalled();

    hydration.resolve(persistedSettings);
    await updatePromise;

    expect(setClientSettings).toHaveBeenCalledWith({
      ...persistedSettings,
      diffIgnoreWhitespace: false,
    });
  });

  it("keeps the user patch in the live snapshot after delayed hydration resolves", async () => {
    const hydration = deferred<ClientSettings | null>();
    const persistedSettings = clientSettings({
      diffWordWrap: true,
      sidebarThreadPreviewCount: 12,
      timestampFormat: "24-hour",
    });
    installLocalApi({
      getClientSettings: vi.fn(() => hydration.promise),
      setClientSettings: vi.fn().mockResolvedValue(undefined),
    });

    const updatePromise = updateSettings({ timestampFormat: "12-hour" });

    hydration.resolve(persistedSettings);
    await updatePromise;
    await Promise.resolve();

    expect(getClientSettings()).toEqual({
      ...persistedSettings,
      timestampFormat: "12-hour",
    });
  });
});

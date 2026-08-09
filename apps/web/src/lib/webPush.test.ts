import { afterEach, describe, expect, it, vi } from "vitest";

import { readWebPushDiagnostics, sendWebPushTest } from "./webPush";

const endpoint = "https://push.example/device";
const PushManagerStub = function PushManager() {};
const subscription = {
  endpoint,
  toJSON: () => ({
    endpoint,
    expirationTime: null,
    keys: { p256dh: "p256dh", auth: "auth" },
  }),
};

function installBrowser({
  permission = "granted",
  currentSubscription = subscription,
  secure = true,
}: {
  permission?: NotificationPermission;
  currentSubscription?: typeof subscription | null;
  secure?: boolean;
} = {}) {
  vi.stubGlobal("window", {
    isSecureContext: secure,
    PushManager: PushManagerStub,
    Notification: {},
  });
  vi.stubGlobal("Notification", { permission });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve({
        pushManager: { getSubscription: vi.fn().mockResolvedValue(currentSubscription) },
      }),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("web push diagnostics", () => {
  it("distinguishes unsupported, denied, missing subscription, and ready", async () => {
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    expect((await readWebPushDiagnostics()).status).toBe("unsupported");

    installBrowser({ permission: "denied" });
    expect((await readWebPushDiagnostics()).status).toBe("permission-denied");

    installBrowser({ currentSubscription: null });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ enabled: true, publicKey: "key" }) }),
    );
    expect((await readWebPushDiagnostics()).status).toBe("subscription-missing");

    installBrowser();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ enabled: true, publicKey: "key" }) }),
    );
    expect(await readWebPushDiagnostics()).toMatchObject({ status: "ready", ready: true });
  });

  it("sends only the current normalized endpoint and fixed kind", async () => {
    installBrowser();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, publicKey: "key" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ accepted: true, url: "/gits?notificationTest=proposal" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await sendWebPushTest("proposal");

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/push/test",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ endpoint, kind: "proposal" }),
      }),
    );
  });

  it("surfaces the server reason when a notification test fails", async () => {
    installBrowser();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ enabled: true, publicKey: "key" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({ error: "This device subscription is not registered." }),
        }),
    );

    await expect(sendWebPushTest("delivery")).rejects.toThrow(
      "This device subscription is not registered.",
    );
  });
});

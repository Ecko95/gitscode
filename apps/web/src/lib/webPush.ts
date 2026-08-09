import type {
  WebPushPublicConfig,
  WebPushRegisterInput,
  WebPushSubscription,
  WebPushTestKind,
  WebPushTestResult,
  WebPushUnregisterInput,
} from "@t3tools/contracts";

const WEB_PUSH_SCOPE = "[WEB_PUSH]";

function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }
  return outputArray.buffer;
}

export function normalizeSubscription(subscription: PushSubscription): WebPushSubscription | null {
  const json = subscription.toJSON();
  if (
    typeof json.endpoint !== "string" ||
    !json.keys ||
    typeof json.keys.p256dh !== "string" ||
    typeof json.keys.auth !== "string"
  ) {
    return null;
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}

export type WebPushDiagnosticStatus =
  | "unsupported"
  | "permission-required"
  | "permission-denied"
  | "server-disabled"
  | "subscription-missing"
  | "ready";

export interface WebPushDiagnostics {
  readonly status: WebPushDiagnosticStatus;
  readonly supported: boolean;
  readonly secureContext: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly serviceWorkerReady: boolean;
  readonly serverConfigured: boolean;
  readonly subscription: WebPushSubscription | null;
  readonly ready: boolean;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}`);
  }
}

export function canUseWebPush(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

export async function getWebPushPublicConfig(): Promise<WebPushPublicConfig> {
  const response = await fetch("/api/push/config", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`/api/push/config failed with HTTP ${response.status}`);
  }
  return (await response.json()) as WebPushPublicConfig;
}

export async function readWebPushDiagnostics(): Promise<WebPushDiagnostics> {
  const secureContext = typeof window !== "undefined" && window.isSecureContext;
  const supported = typeof navigator !== "undefined" && canUseWebPush();
  const base = {
    supported,
    secureContext,
    permission: supported ? Notification.permission : ("unsupported" as const),
    serviceWorkerReady: false,
    serverConfigured: false,
    subscription: null,
    ready: false,
  };
  if (!supported) return { ...base, status: "unsupported" };
  if (Notification.permission === "denied") return { ...base, status: "permission-denied" };
  if (Notification.permission !== "granted") return { ...base, status: "permission-required" };

  const [config, registration] = await Promise.all([
    getWebPushPublicConfig(),
    navigator.serviceWorker.ready,
  ]);
  if (!config.enabled || !config.publicKey) {
    return { ...base, serviceWorkerReady: true, status: "server-disabled" };
  }
  const subscription = await registration.pushManager.getSubscription();
  const normalized = subscription ? normalizeSubscription(subscription) : null;
  if (!normalized) {
    return {
      ...base,
      serviceWorkerReady: true,
      serverConfigured: true,
      status: "subscription-missing",
    };
  }
  return {
    ...base,
    serviceWorkerReady: true,
    serverConfigured: true,
    subscription: normalized,
    ready: true,
    status: "ready",
  };
}

export async function sendWebPushTest(kind: WebPushTestKind): Promise<WebPushTestResult> {
  const diagnostics = await readWebPushDiagnostics();
  if (!diagnostics.ready || diagnostics.subscription === null) {
    throw new Error("Push to phone is not ready on this device.");
  }
  const response = await fetch("/api/push/test", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: diagnostics.subscription.endpoint, kind }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { readonly error?: unknown } | null;
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : `/api/push/test failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as WebPushTestResult;
}

export async function registerWebPushSubscription(): Promise<void> {
  if (!canUseWebPush()) {
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }

  const config = await getWebPushPublicConfig();
  if (!config.enabled || !config.publicKey) {
    console.info(`${WEB_PUSH_SCOPE} VAPID is not configured on the server`);
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription =
    existingSubscription ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToArrayBuffer(config.publicKey),
    }));
  const normalized = normalizeSubscription(subscription);
  if (!normalized) {
    throw new Error("Browser returned an invalid PushSubscription.");
  }

  const input: WebPushRegisterInput = {
    subscription: normalized,
    userAgent: navigator.userAgent,
  };
  await postJson("/api/push/subscriptions", input);
}

export async function unregisterWebPushSubscription(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    return;
  }
  const endpoint = subscription.endpoint;
  const input: WebPushUnregisterInput = { endpoint };
  await postJson("/api/push/subscriptions/delete", input).catch((error: unknown) => {
    console.warn(`${WEB_PUSH_SCOPE} server unregister failed`, error);
  });
  await subscription.unsubscribe();
}

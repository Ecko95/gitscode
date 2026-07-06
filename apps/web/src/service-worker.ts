/// <reference lib="webworker" />

type PrecacheEntry = {
  readonly url: string;
  readonly revision: string | null;
};

type PushPayload = {
  readonly title?: string;
  readonly body?: string;
  readonly tag?: string;
  readonly url?: string;
};

const sw = self as unknown as ServiceWorkerGlobalScope & {
  readonly __WB_MANIFEST: ReadonlyArray<PrecacheEntry>;
};

const CACHE_NAME = "gits-app-shell-v1";
const PRECACHE_URLS = (
  self as unknown as { readonly __WB_MANIFEST: ReadonlyArray<PrecacheEntry> }
).__WB_MANIFEST.map((entry) => entry.url);

sw.skipWaiting();

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS.filter((url) => !url.startsWith("/api/")))),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => sw.clients.claim()),
  );
});

function shouldHandleFetch(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return false;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/attachments/")) return false;
  return request.mode === "navigate" || PRECACHE_URLS.includes(url.pathname);
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fetched = fetch(request)
    .then((response) => {
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached ?? ((await fetched) as Response);
}

sw.addEventListener("fetch", (event) => {
  if (!shouldHandleFetch(event.request)) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("/index.html")) ?? Response.error();
      }),
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

sw.addEventListener("push", (event) => {
  const payload = ((): PushPayload => {
    try {
      return event.data?.json() ?? {};
    } catch {
      return {};
    }
  })();

  event.waitUntil(
    sw.registration.showNotification(payload.title ?? "GITS", {
      ...(payload.body ? { body: payload.body } : {}),
      ...(payload.tag ? { tag: payload.tag } : {}),
      data: { url: payload.url ?? "/" },
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    typeof event.notification.data?.url === "string" ? event.notification.data.url : "/",
    sw.location.origin,
  ).toString();

  event.waitUntil(
    sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if ("focus" in client && client.url === url) {
          return client.focus();
        }
      }
      return sw.clients.openWindow(url);
    }),
  );
});

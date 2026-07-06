import { registerSW } from "virtual:pwa-register";

export const updateServiceWorker = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    // ponytail: keep updates simple; the SW calls skipWaiting/clients.claim.
    void registration?.update();
  },
});

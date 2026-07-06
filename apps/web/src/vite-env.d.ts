/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  nativeApi?: import("@t3tools/contracts").LocalApi;
  desktopBridge?: import("@t3tools/contracts").DesktopBridge;
}

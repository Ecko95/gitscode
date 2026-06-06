import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { SplashScreen } from "./components/SplashScreen";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";

const MIN_BOOT_SCREEN_MS = 10_000;

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

function InitialBootGate() {
  const [bootComplete, setBootComplete] = useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setBootComplete(true);
    }, MIN_BOOT_SCREEN_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  return bootComplete ? <RouterProvider router={router} /> : <SplashScreen />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <InitialBootGate />
  </React.StrictMode>,
);

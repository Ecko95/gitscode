import "../index.css";

import type { PortRecord, PortsListResult } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  browserPreview: {
    control: vi.fn(),
    open: vi.fn(),
    status: vi.fn(),
  },
  openDesktopSshUrl: vi.fn(),
  portsList: vi.fn(),
  remoteRecord: null as null | { desktopSsh?: { host: string; port: number; username: string } },
  terminalSessions: [] as unknown[],
}));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({
    browserPreview: mocks.browserPreview,
    ports: { list: mocks.portsList },
  }),
  readEnvironmentBrowserPreviewApi: () => mocks.browserPreview,
}));
vi.mock("../environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => "https://remote.example.test/",
  getSavedEnvironmentRecord: () => mocks.remoteRecord,
}));
vi.mock("../terminalSessionState", () => ({
  useKnownTerminalSessions: () => mocks.terminalSessions,
}));
vi.mock("../localApi", () => ({
  openDesktopSshUrl: mocks.openDesktopSshUrl,
  readLocalApi: () => null,
}));
vi.mock("./DevCommandsControl", () => ({
  default: () => <button type="button">Dev commands</button>,
}));

import { BrowserPreviewPanel } from "./BrowserPreviewPanel";

const configuredPort: PortRecord = {
  id: "127.0.0.1:5173",
  remoteHost: "127.0.0.1",
  remotePort: 5173,
  protocol: "http",
  label: "Configured web",
  sources: ["configured"],
  listenerStatus: "stopped",
  ownership: "unmanaged",
  commandId: "web-dev",
  supervisedStatus: "stopped",
  exposureStatus: "none",
};
const listenerPort: PortRecord = {
  id: "127.0.0.1:8080",
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  protocol: "tcp",
  label: "node",
  sources: ["listener"],
  listenerStatus: "ready",
  ownership: "unmanaged",
  supervisedStatus: "unavailable",
  exposureStatus: "none",
};
const snapshot: PortsListResult = {
  projectDir: "/repo",
  threadId: "thread-1" as never,
  scannedAt: "2026-07-17T21:00:00.000Z",
  ports: [configuredPort, listenerPort],
  warnings: [],
};

function renderPanel() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BrowserPreviewPanel
        environmentId={"environment-1" as never}
        threadId={"thread-1" as never}
        projectDir="/repo"
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.remoteRecord = null;
  mocks.terminalSessions = [
    {
      target: {
        environmentId: "environment-1",
        threadId: "thread-1",
        terminalId: "terminal-1",
      },
      state: {
        summary: {
          label: "Vite terminal",
          hasRunningSubprocess: true,
          updatedAt: "2026-07-17T21:00:00.000Z",
        },
        buffer: "Local: http://localhost:4173/",
        status: "running",
        hasRunningSubprocess: true,
      },
    },
  ];
  mocks.portsList.mockResolvedValue(snapshot);
  mocks.browserPreview.open.mockResolvedValue({ previewPath: null, terminalUrl: null });
  mocks.browserPreview.control.mockResolvedValue({
    available: true,
    status: "live",
    previewPath: "/api/browser-preview/view/ticket",
    terminalUrl: "http://127.0.0.1:5173/",
    consoleEntries: [],
    expiresAt: null,
    message: null,
  });
  mocks.openDesktopSshUrl.mockResolvedValue({ opened: true, localUrl: "http://127.0.0.1:55173/" });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("BrowserPreviewPanel ports inventory", () => {
  it("shows configured, terminal, detected, and manual rows", async () => {
    const screen = await renderPanel();
    try {
      await expect.element(page.getByText("In GITS (VPS browser)")).toBeInTheDocument();
      await expect.element(page.getByText("Configured web")).toBeInTheDocument();
      await expect.element(page.getByText("4173")).toBeInTheDocument();
      await expect.element(page.getByText("node")).toBeInTheDocument();

      await userEvent.fill(page.getByLabelText("Manual port"), "9000");
      await page.getByRole("button", { name: "Add port" }).click();
      await expect.element(page.getByText("9000", { exact: true })).toBeInTheDocument();

      const detectedRow = document.querySelector<HTMLElement>('[data-port-id="127.0.0.1:8080"]');
      expect(detectedRow).not.toBeNull();
      const lifecycleButtons = Array.from(
        detectedRow?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      ).filter((button) => button.textContent === "Start" || button.textContent === "Stop");
      expect(lifecycleButtons).toHaveLength(2);
      expect(lifecycleButtons.every((button) => button.disabled)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("previews the exact HTTP port and keeps a cross-origin viewer out of an iframe", async () => {
    const screen = await renderPanel();
    try {
      await page.getByRole("button", { name: "Preview 5173 in GITS" }).click();
      await vi.waitFor(() =>
        expect(mocks.browserPreview.control).toHaveBeenCalledWith({
          threadId: "thread-1",
          action: "navigate",
          url: "http://127.0.0.1:5173/",
        }),
      );
      expect(document.querySelector("iframe")).toBeNull();
      await expect
        .element(page.getByRole("button", { name: "Open supervised browser" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("offers Open locally only for a Desktop SSH environment", async () => {
    mocks.remoteRecord = {
      desktopSsh: { host: "vps.example", port: 22, username: "ops" },
    };
    const screen = await renderPanel();
    try {
      await expect
        .element(page.getByText("Local via SSH (this computer only)"))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Open 5173 locally" }).click();
      expect(mocks.openDesktopSshUrl).toHaveBeenCalledWith({
        target: mocks.remoteRecord.desktopSsh,
        url: "http://127.0.0.1:5173/",
      });
    } finally {
      await screen.unmount();
    }
  });
});

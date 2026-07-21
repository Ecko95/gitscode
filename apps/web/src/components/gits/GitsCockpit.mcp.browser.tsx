import "../../index.css";

import { ProviderInstanceId, type GitsMcpInventorySnapshot } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { McpServersPanel } from "./cockpit/McpPanel";

const snapshot: GitsMcpInventorySnapshot = {
  scannedAt: "2026-07-17T12:00:00.000Z",
  servers: [
    {
      id: "codex:supabase",
      provider: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      name: "supabase",
      source: "codex-app-server",
      runtimeSource: "codex-app-server",
      status: "stopped",
      runtimeStatus: "stopped",
      authStatus: "unauthenticated",
      canAuthenticate: true,
      enabled: true,
      command: null,
      transport: "streamable-http",
      toolCount: 0,
      resourceCount: 0,
      tools: [],
      configPath: "/home/test/.codex/config.toml",
      error: null,
    },
  ],
  providers: [
    { provider: "codex", serverCount: 1, runningCount: 0, disabledCount: 0, toolCount: 0 },
  ],
  totals: { serverCount: 1, runningCount: 0, errorCount: 0, disabledCount: 0, toolCount: 0 },
  warnings: [],
};

const renderPanel = (available: boolean, onAuthenticate = vi.fn()) =>
  render(
    <McpServersPanel
      snapshot={snapshot}
      loading={false}
      error={null}
      overrides={{}}
      authAvailability={{ available }}
      authPending={false}
      authStatus={null}
      authError={null}
      onRefresh={vi.fn()}
      onToggleServer={vi.fn()}
      onAuthenticate={onAuthenticate}
      onCancelAuthentication={vi.fn()}
    />,
  );

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("MCP authentication controls", () => {
  it("offers authentication only when runtime status and relay preflight allow it", async () => {
    const onAuthenticate = vi.fn();
    const screen = await renderPanel(true, onAuthenticate);
    try {
      const authenticate = page.getByRole("button", { name: "Authenticate" });
      await expect.element(authenticate).toBeInTheDocument();
      await authenticate.click();
      expect(onAuthenticate).toHaveBeenCalledWith(snapshot.servers[0]);
    } finally {
      await screen.unmount();
    }
  });

  it("shows exact-forward and PAT guidance when callback relay preflight is unavailable", async () => {
    const screen = await renderPanel(false);
    try {
      await expect.element(page.getByText(/exact SSH forward/i)).toBeInTheDocument();
      await expect.element(page.getByText(/PAT/i)).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Authenticate" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});

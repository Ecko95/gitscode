import "../../index.css";

import {
  ProviderAuthSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderInstanceCard, type ProviderAuthActions } from "./ProviderInstanceCard.tsx";
import { getDriverOption } from "./providerDriverMeta.ts";

const instanceId = ProviderInstanceId.make("codex-personal");
const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  config: {},
};
const session = {
  sessionId: ProviderAuthSessionId.make("provider-auth-browser-test"),
  providerInstanceId: instanceId,
  method: "device-code" as const,
  state: "awaiting-user" as const,
  prompt: "Open the verification page and follow the provider instructions.",
  acceptsCode: false,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function makeProvider(authenticated: boolean): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: authenticated ? "authenticated" : "unauthenticated" },
    checkedAt: "2026-07-17T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

function renderCard(input: {
  readonly authenticated: boolean;
  readonly authActions: ProviderAuthActions;
}) {
  return render(
    <ProviderInstanceCard
      instanceId={instanceId}
      instance={instance}
      driverOption={getDriverOption(instance.driver)}
      liveProvider={makeProvider(input.authenticated)}
      isExpanded={false}
      onExpandedChange={() => undefined}
      onUpdate={() => undefined}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={() => undefined}
      onFavoriteModelsChange={() => undefined}
      onModelOrderChange={() => undefined}
      authActions={input.authActions}
    />,
  );
}

let mounted: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe("ProviderInstanceCard Codex authentication", () => {
  it("keeps ChatGPT subscription login separate from API-key billing", async () => {
    const start = vi.fn<ProviderAuthActions["start"]>().mockResolvedValue({
      session,
      verificationUri: "https://auth.example.test/device",
      userCode: "ABCD-EFGH",
    });
    const cancel = vi.fn<ProviderAuthActions["cancel"]>().mockResolvedValue(undefined);
    const openExternal = vi.fn<ProviderAuthActions["openExternal"]>().mockResolvedValue(undefined);
    const authActions: ProviderAuthActions = {
      start,
      get: vi.fn().mockResolvedValue(session),
      cancel,
      submitCode: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      openExternal,
    };
    mounted = await renderCard({ authenticated: false, authActions });

    await expect.element(page.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    await expect
      .element(page.getByText(/ChatGPT subscription sign-in uses a device code/))
      .toBeInTheDocument();
    await expect.element(page.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.element(page.getByText("ABCD-EFGH")).toBeInTheDocument();
    await page.getByRole("button", { name: "Open verification page" }).click();
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/device");

    await page.getByRole("button", { name: "Cancel sign-in" }).click();
    expect(cancel).toHaveBeenCalledWith({ sessionId: session.sessionId });
    await expect.element(page.getByText("ABCD-EFGH")).not.toBeInTheDocument();
  });

  it("offers change-login and sign-out controls for an authenticated account", async () => {
    const logout = vi.fn<ProviderAuthActions["logout"]>().mockResolvedValue(undefined);
    const authActions: ProviderAuthActions = {
      start: vi.fn().mockResolvedValue({ session }),
      get: vi.fn().mockResolvedValue(session),
      cancel: vi.fn().mockResolvedValue(undefined),
      submitCode: vi.fn(),
      logout,
      openExternal: vi.fn().mockResolvedValue(undefined),
    };
    mounted = await renderCard({ authenticated: true, authActions });

    await expect.element(page.getByRole("button", { name: "Change login" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Sign out" }).click();
    expect(logout).toHaveBeenCalledWith({ providerInstanceId: instanceId });
  });
});

describe("ProviderInstanceCard Claude authentication", () => {
  it("submits one browser code and removes the form immediately", async () => {
    const claudeInstanceId = ProviderInstanceId.make("claude-work");
    const claudeInstance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      config: { homePath: "/srv/provider-homes/claude-work" },
    };
    const claudeSession = {
      ...session,
      providerInstanceId: claudeInstanceId,
      method: "manual-code" as const,
      acceptsCode: true,
    };
    const submitCode = vi.fn<ProviderAuthActions["submitCode"]>().mockResolvedValue({
      ...claudeSession,
      state: "waiting-provider",
      acceptsCode: false,
    });
    const authActions: ProviderAuthActions = {
      start: vi.fn().mockResolvedValue({
        session: claudeSession,
        verificationUri: "https://claude.ai/oauth/authorize",
      }),
      get: vi.fn().mockResolvedValue(claudeSession),
      cancel: vi.fn().mockResolvedValue(undefined),
      submitCode,
      logout: vi.fn().mockResolvedValue(undefined),
      openExternal: vi.fn().mockResolvedValue(undefined),
    };
    mounted = await render(
      <ProviderInstanceCard
        instanceId={claudeInstanceId}
        instance={claudeInstance}
        driverOption={getDriverOption(claudeInstance.driver)}
        liveProvider={{
          ...makeProvider(false),
          instanceId: claudeInstanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
        }}
        isExpanded={false}
        onExpandedChange={() => undefined}
        onUpdate={() => undefined}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={() => undefined}
        onFavoriteModelsChange={() => undefined}
        onModelOrderChange={() => undefined}
        authActions={authActions}
      />,
    );

    await page.getByRole("button", { name: "Sign in" }).click();
    await expect.element(page.getByLabelText("Authorization code")).toBeInTheDocument();
    await page.getByLabelText("Authorization code").fill("private-browser-code");
    await page.getByRole("button", { name: "Submit code" }).click();

    expect(submitCode).toHaveBeenCalledWith({
      sessionId: claudeSession.sessionId,
      code: "private-browser-code",
    });
    await expect.element(page.getByLabelText("Authorization code")).not.toBeInTheDocument();
  });
});

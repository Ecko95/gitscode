import {
  ProviderAuthCapabilityId,
  ProviderDriverKind,
  type ProviderAuthCapability,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import {
  discoverOpenCodeAuthCapabilities,
  startOpenCodeAuth,
  type OpenCodeAuthApi,
} from "./OpenCodeAuth.ts";

const provider = ProviderDriverKind.make("opencode");

function makeApi(methods: Awaited<ReturnType<OpenCodeAuthApi["methods"]>>): OpenCodeAuthApi & {
  readonly authorize: ReturnType<typeof vi.fn<OpenCodeAuthApi["authorize"]>>;
  readonly callback: ReturnType<typeof vi.fn<OpenCodeAuthApi["callback"]>>;
  readonly setApiKey: ReturnType<typeof vi.fn<OpenCodeAuthApi["setApiKey"]>>;
} {
  return {
    methods: vi.fn().mockResolvedValue(methods),
    authorize: vi.fn(),
    callback: vi.fn().mockResolvedValue(true),
    setApiKey: vi.fn().mockResolvedValue(true),
  };
}

function findCapability(
  capabilities: ReadonlyArray<ProviderAuthCapability>,
  label: string,
): ProviderAuthCapability {
  const capability = capabilities.find((candidate) => candidate.label === label);
  if (!capability) throw new Error(`Missing capability: ${label}`);
  return capability;
}

describe("OpenCodeAuth", () => {
  it("discovers only methods reported by the connected server", async () => {
    const api = makeApi({
      openai: [
        { type: "oauth", label: "ChatGPT headless device code" },
        { type: "oauth", label: "ChatGPT browser OAuth" },
        { type: "api", label: "OpenAI API key" },
      ],
    });

    const capabilities = await Effect.runPromise(discoverOpenCodeAuthCapabilities(api));

    expect(capabilities.map(({ method, label }) => ({ method, label }))).toEqual([
      { method: "oauth", label: "ChatGPT headless device code" },
      { method: "oauth", label: "ChatGPT browser OAuth" },
      { method: "api-key", label: "OpenAI API key" },
    ]);
    expect(capabilities).not.toContainEqual(expect.objectContaining({ method: "guided-terminal" }));
  });

  it("surfaces a reported device code without retaining provider instructions", async () => {
    const api = makeApi({
      "github-copilot": [{ type: "oauth", label: "Login with GitHub Copilot" }],
    });
    api.authorize.mockResolvedValue({
      url: "https://github.com/login/device",
      method: "auto",
      instructions: "Enter code: ABCD-EFGH",
    });
    const capabilities = await Effect.runPromise(discoverOpenCodeAuthCapabilities(api));
    const capability = findCapability(capabilities, "Login with GitHub Copilot");

    const attempt = await Effect.runPromise(
      startOpenCodeAuth({
        provider,
        api,
        capabilityId: capability.id,
        method: capability.method,
      }),
    );
    const readiness = await Effect.runPromise(attempt.readiness!);

    expect(readiness).toEqual({
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-EFGH",
      sanitizedPrompt: "Open the verification page and enter the device code.",
      acceptsCode: false,
    });
    await expect(Effect.runPromise(attempt.completion)).resolves.toBe(true);
    expect(api.callback).toHaveBeenCalledWith("github-copilot", 0);
    expect(JSON.stringify(attempt)).not.toContain("Enter code:");
  });

  it("submits manual OAuth codes and API keys only through private request bodies", async () => {
    const api = makeApi({
      example: [
        { type: "oauth", label: "Example OAuth" },
        { type: "api", label: "Example API key" },
      ],
    });
    api.authorize.mockResolvedValue({
      url: "https://login.example.test/authorize",
      method: "code",
      instructions: "Paste the browser code here",
    });
    const capabilities = await Effect.runPromise(discoverOpenCodeAuthCapabilities(api));

    const oauthAttempt = await Effect.runPromise(
      startOpenCodeAuth({
        provider,
        api,
        capabilityId: findCapability(capabilities, "Example OAuth").id,
        method: "oauth",
      }),
    );
    expect(await Effect.runPromise(oauthAttempt.readiness!)).toEqual({
      verificationUri: "https://login.example.test/authorize",
      sanitizedPrompt: "Open the verification page, then enter the authorization code.",
      acceptsCode: true,
    });
    await Effect.runPromise(oauthAttempt.submitCode!("private-oauth-code"));
    await expect(Effect.runPromise(oauthAttempt.completion)).resolves.toBe(true);
    expect(api.callback).toHaveBeenCalledWith("example", 0, "private-oauth-code");

    const apiKeyAttempt = await Effect.runPromise(
      startOpenCodeAuth({
        provider,
        api,
        capabilityId: findCapability(capabilities, "Example API key").id,
        method: "api-key",
      }),
    );
    expect(await Effect.runPromise(apiKeyAttempt.readiness!)).toEqual({
      sanitizedPrompt: "Enter the credential for Example API key.",
      acceptsCode: true,
    });
    await Effect.runPromise(apiKeyAttempt.submitCode!("private-api-key"));
    await expect(Effect.runPromise(apiKeyAttempt.completion)).resolves.toBe(true);
    expect(api.setApiKey).toHaveBeenCalledWith("example", "private-api-key");
  });

  it("rejects stale or invented capability identifiers", async () => {
    const api = makeApi({ openai: [{ type: "api", label: "OpenAI API key" }] });

    await expect(
      Effect.runPromise(
        startOpenCodeAuth({
          provider,
          api,
          capabilityId: ProviderAuthCapabilityId.make("opencode:invented:99"),
          method: "api-key",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  });
});

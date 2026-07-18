import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  ProviderAuthCapability,
  ProviderAuthSession,
  ProviderAuthStartInput,
  ProviderAuthSubmitCodeInput,
} from "./providerAuth.ts";

const decodeSession = Schema.decodeUnknownSync(ProviderAuthSession);
const decodeCapability = Schema.decodeUnknownSync(ProviderAuthCapability);
const decodeStart = Schema.decodeUnknownSync(ProviderAuthStartInput);

const validSession = {
  sessionId: "auth-session-1",
  providerInstanceId: "codex_personal",
  method: "device-code",
  state: "awaiting-user",
  prompt: "Open the verification page and enter the displayed code.",
  acceptsCode: false,
  expiresAt: "2026-07-17T20:00:00.000Z",
} as const;

describe("ProviderAuthSession", () => {
  it("accepts only known authentication methods and lifecycle states", () => {
    expect(decodeSession(validSession)).toEqual(validSession);
    expect(() => decodeSession({ ...validSession, method: "magic-link" })).toThrow();
    expect(() => decodeSession({ ...validSession, state: "pending" })).toThrow();
  });

  it("strips transient secrets from the persistable and broadcast-safe shape", () => {
    const decoded = decodeSession({
      ...validSession,
      verificationUri: "https://login.example.test/verify?state=oauth-state",
      userCode: "ABCD-EFGH",
      authorizationCode: "secret-code",
      transcript: "provider output containing a token",
    });

    expect(decoded).toEqual(validSession);
    expect(Object.keys(decoded).sort()).toEqual(
      [
        "acceptsCode",
        "expiresAt",
        "method",
        "prompt",
        "providerInstanceId",
        "sessionId",
        "state",
      ].sort(),
    );
    expect(JSON.stringify(decoded)).not.toContain("oauth-state");
    expect(JSON.stringify(decoded)).not.toContain("ABCD-EFGH");
    expect(JSON.stringify(decoded)).not.toContain("secret-code");
    expect(JSON.stringify(decoded)).not.toContain("provider output");
  });

  it("accepts a bounded manual-code submission without adding it to session state", () => {
    const decode = Schema.decodeUnknownSync(ProviderAuthSubmitCodeInput);
    expect(decode({ sessionId: validSession.sessionId, code: "browser-code" })).toEqual({
      sessionId: validSession.sessionId,
      code: "browser-code",
    });
    expect(() => decode({ sessionId: validSession.sessionId, code: "" })).toThrow();
    expect(() => decode({ sessionId: validSession.sessionId, code: "x".repeat(4_097) })).toThrow();
  });

  it("accepts reported OAuth capabilities and an opaque start selection", () => {
    const capability = decodeCapability({
      id: "opencode:openai:0",
      method: "oauth",
      label: "ChatGPT headless",
    });
    expect(capability.method).toBe("oauth");
    expect(
      decodeStart({
        providerInstanceId: validSession.providerInstanceId,
        method: capability.method,
        capabilityId: capability.id,
      }),
    ).toEqual({
      providerInstanceId: validSession.providerInstanceId,
      method: "oauth",
      capabilityId: "opencode:openai:0",
    });
  });
});

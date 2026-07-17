import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ProviderAuthSession } from "./providerAuth.ts";

const decodeSession = Schema.decodeUnknownSync(ProviderAuthSession);

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
});

import { describe, expect, it } from "vitest";

import {
  classifyEnvironmentUrl,
  extractLoopbackRedirectUri,
  isLoopbackHostname,
  normalizeLoopbackDisplayUrl,
  rewriteLoopbackOrigin,
} from "./environmentUrl.ts";

describe("environment URLs", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.42.1.9", "[::1]"])(
    "recognizes loopback hostname %s",
    (hostname) => expect(isLoopbackHostname(hostname)).toBe(true),
  );

  it.each(["example.com", "0.0.0.0", "128.0.0.1", "[::]"])(
    "rejects non-loopback hostname %s",
    (hostname) => expect(isLoopbackHostname(hostname)).toBe(false),
  );

  it("normalizes wildcard display addresses without changing the rest of the URL", () => {
    expect(normalizeLoopbackDisplayUrl(new URL("http://0.0.0.0:5173/a?q=1#x")).toString()).toBe(
      "http://127.0.0.1:5173/a?q=1#x",
    );
    expect(normalizeLoopbackDisplayUrl(new URL("https://[::]:4173/a")).toString()).toBe(
      "https://[::1]:4173/a",
    );
  });

  it("classifies direct and OAuth loopback URLs", () => {
    expect(classifyEnvironmentUrl("http://localhost:5173").kind).toBe("loopback");
    expect(classifyEnvironmentUrl("https://example.com/docs").kind).toBe("external");
    expect(
      classifyEnvironmentUrl(
        "https://provider.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcallback",
      ).kind,
    ).toBe("oauth-loopback");
    expect(() => classifyEnvironmentUrl("file:///etc/passwd")).toThrow(/HTTP/i);
  });

  it("extracts only HTTP loopback redirect URIs", () => {
    expect(
      extractLoopbackRedirectUri(
        new URL(
          "https://provider.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback%3Fx%3D1",
        ),
      )?.toString(),
    ).toBe("http://localhost:1455/callback?x=1");
    expect(
      extractLoopbackRedirectUri(
        new URL("https://provider.example/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb"),
      ),
    ).toBeNull();
    expect(
      extractLoopbackRedirectUri(
        new URL("https://provider.example/authorize?redirect_uri=not-a-url"),
      ),
    ).toBeNull();
  });

  it("rewrites only the loopback origin", () => {
    expect(
      rewriteLoopbackOrigin({
        url: new URL("http://localhost:5173/path?q=1#x"),
        localPort: 49152,
      }).toString(),
    ).toBe("http://127.0.0.1:49152/path?q=1#x");
    expect(() =>
      rewriteLoopbackOrigin({ url: new URL("https://example.com/path"), localPort: 49152 }),
    ).toThrow(/loopback/i);
    expect(() =>
      rewriteLoopbackOrigin({ url: new URL("http://localhost/path"), localPort: 65_536 }),
    ).toThrow(/port/i);
  });
});

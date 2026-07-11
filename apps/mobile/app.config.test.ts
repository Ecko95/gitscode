import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_APP_VARIANT = process.env.APP_VARIANT;

async function loadConfig(appVariant: "development" | "preview" | "production") {
  process.env.APP_VARIANT = appVariant;
  vi.resetModules();
  return (await import("./app.config.ts")).default;
}

afterEach(() => {
  if (ORIGINAL_APP_VARIANT === undefined) {
    delete process.env.APP_VARIANT;
  } else {
    process.env.APP_VARIANT = ORIGINAL_APP_VARIANT;
  }
  vi.resetModules();
});

describe("iOS App Transport Security", () => {
  it("allows arbitrary loads for development builds", async () => {
    const config = await loadConfig("development");

    expect(config.ios?.infoPlist?.NSAppTransportSecurity).toEqual({
      NSAllowsArbitraryLoads: true,
    });
  });

  it.each(["preview", "production"] as const)(
    "does not emit an arbitrary-load exception for %s builds",
    async (appVariant) => {
      const config = await loadConfig(appVariant);

      expect(config.ios?.infoPlist?.NSAppTransportSecurity).toBeUndefined();
    },
  );
});

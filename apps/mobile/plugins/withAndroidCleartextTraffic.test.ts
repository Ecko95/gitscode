import { afterEach, describe, expect, it } from "vitest";

// ponytail: no expo mock needed — withAndroidManifest returns a mod-config; we call the registered
// action directly to verify the mutation fn. Simpler than mocking CJS require() which vitest can't intercept.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("./withAndroidCleartextTraffic.cjs") as (config: Config) => Config & ExpoMod;

interface Config {
  modResults: {
    manifest: {
      application: Array<{ $: Record<string, string> }>;
    };
  };
}

interface ExpoMod {
  mods?: {
    android?: {
      manifest?: (
        config: Config & { modRequest: { nextMod: (c: Config) => Config } },
      ) => Promise<Config>;
    };
  };
}

/** Minimal Expo config shape the plugin actually touches */
function makeConfig(applicationAttrs: Record<string, string> = {}): Config {
  return {
    modResults: {
      manifest: {
        application: [{ $: { ...applicationAttrs } }],
      },
    },
  };
}

/** Run the registered manifest mod action to verify the mutation function. */
async function applyManifestMod(result: Config & ExpoMod): Promise<Config> {
  const action = result.mods?.android?.manifest;
  if (action == null) throw new Error("expected manifest mod to be registered");
  return action({ ...result, modRequest: { nextMod: (c: Config) => c } });
}

describe("withAndroidCleartextTraffic", () => {
  const originalVariant = process.env.APP_VARIANT;

  afterEach(() => {
    if (originalVariant === undefined) {
      delete process.env.APP_VARIANT;
    } else {
      process.env.APP_VARIANT = originalVariant;
    }
  });

  it("sets usesCleartextTraffic=true for development variant", async () => {
    process.env.APP_VARIANT = "development";
    const modConfig = plugin(makeConfig());
    const result = await applyManifestMod(modConfig);
    expect(result.modResults.manifest.application[0].$["android:usesCleartextTraffic"]).toBe(
      "true",
    );
  });

  it("does NOT set usesCleartextTraffic for production variant", () => {
    process.env.APP_VARIANT = "production";
    const input = makeConfig();
    const result = plugin(input);
    expect(result).toBe(input);
    expect(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
    ).toBeUndefined();
  });

  it("does NOT set usesCleartextTraffic when APP_VARIANT is unset", () => {
    delete process.env.APP_VARIANT;
    const input = makeConfig();
    const result = plugin(input);
    expect(result).toBe(input);
    expect(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
    ).toBeUndefined();
  });

  it("does NOT set usesCleartextTraffic for preview variant", () => {
    process.env.APP_VARIANT = "preview";
    const input = makeConfig();
    const result = plugin(input);
    expect(result).toBe(input);
    expect(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
    ).toBeUndefined();
  });
});

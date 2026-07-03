// @ts-check
"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { describe, it, afterEach } = require("node:test");

// Stub expo/config-plugins so the test has no expo dependency.
// withAndroidManifest(config, fn) just calls fn(config) synchronously.
// ponytail: minimal stub — expand if plugin grows to use other expo APIs.
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "expo/config-plugins") {
    return {
      withAndroidManifest: (config, fn) => fn(config),
    };
  }
  return originalLoad.call(this, request, ...rest);
};

// Load after stub is in place
delete require.cache[require.resolve("./withAndroidCleartextTraffic.cjs")];
const plugin = require("./withAndroidCleartextTraffic.cjs");

/** Minimal Expo config shape the plugin actually touches */
function makeConfig(applicationAttrs = {}) {
  return {
    modResults: {
      manifest: {
        application: [{ $: { ...applicationAttrs } }],
      },
    },
  };
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

  it("sets usesCleartextTraffic=true for development variant", () => {
    process.env.APP_VARIANT = "development";
    const result = plugin(makeConfig());
    assert.equal(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
      "true",
    );
  });

  it("does NOT set usesCleartextTraffic for production variant", () => {
    process.env.APP_VARIANT = "production";
    const input = makeConfig();
    const result = plugin(input);
    assert.equal(result, input);
    assert.equal(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
      undefined,
    );
  });

  it("does NOT set usesCleartextTraffic when APP_VARIANT is unset", () => {
    delete process.env.APP_VARIANT;
    const input = makeConfig();
    const result = plugin(input);
    assert.equal(result, input);
    assert.equal(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
      undefined,
    );
  });

  it("does NOT set usesCleartextTraffic for preview variant", () => {
    process.env.APP_VARIANT = "preview";
    const input = makeConfig();
    const result = plugin(input);
    assert.equal(result, input);
    assert.equal(
      result.modResults.manifest.application[0].$["android:usesCleartextTraffic"],
      undefined,
    );
  });
});

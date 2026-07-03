const { withAndroidManifest } = require("expo/config-plugins");

// ponytail: build-time env gate only; per-flavor productFlavors would allow a
// single APK for all variants but requires Gradle config changes — add if EAS
// multi-variant builds become the norm.
module.exports = function withAndroidCleartextTraffic(config) {
  if (process.env.APP_VARIANT !== "development") {
    return config;
  }

  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];

    if (application == null) {
      throw new Error(
        "AndroidManifest.xml is missing the application element required for cleartext traffic configuration.",
      );
    }

    application.$ ??= {};
    application.$["android:usesCleartextTraffic"] = "true";

    return nextConfig;
  });
};

export const DEFAULT_T3_RELAY_DOMAIN = "t3code-relay.ineededadomain.com";

export const DEFAULT_T3_RELAY_URL = `https://${DEFAULT_T3_RELAY_DOMAIN}`;

export const DEFAULT_T3_RELAY_ZONE_NAME = "ineededadomain.com";

export const DEFAULT_T3_CLERK_PUBLISHABLE_KEY =
  "pk_test_YXdhaXRlZC1tb25rZmlzaC01OC5jbGVyay5hY2NvdW50cy5kZXYk";

export function clerkFrontendApiUrlFromPublishableKey(publishableKey: string): string {
  const encodedFrontendApi = publishableKey.split("_").slice(2).join("_");
  const frontendApi = globalThis.atob(encodedFrontendApi).replace(/\$$/u, "");
  if (frontendApi.length === 0 || frontendApi.includes("/")) {
    throw new Error("Invalid Clerk publishable key.");
  }
  return `https://${frontendApi}`;
}

export const RELAY_CLERK_JWT_TEMPLATE = "t3-relay";

export const RELAY_CLERK_TOKEN_OPTIONS = {
  template: RELAY_CLERK_JWT_TEMPLATE,
  skipCache: true,
} as const;

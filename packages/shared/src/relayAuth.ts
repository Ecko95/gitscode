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

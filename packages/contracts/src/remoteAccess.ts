import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DesktopSshEnvironmentTargetSchema, type DesktopSshEnvironmentTarget } from "./ipc.ts";

/**
 * Neutral alias for the SSH target schema. The underlying schema lives under the
 * `Desktop*` prefix in `ipc.ts`, but the SSH engine in `packages/ssh` and the
 * headless server-side registry are desktop-agnostic. Re-exporting it under a
 * neutral name avoids leaking the `Desktop*` naming into server-side code while
 * keeping a single shared schema (no duplication).
 */
export const RemoteSshTargetSchema = DesktopSshEnvironmentTargetSchema;
export type RemoteSshTarget = DesktopSshEnvironmentTarget;

export const AdvertisedEndpointProviderKind = Schema.Literals([
  "core",
  "private-network",
  "tunnel",
  "manual",
]);
export type AdvertisedEndpointProviderKind = typeof AdvertisedEndpointProviderKind.Type;

export const AdvertisedEndpointReachability = Schema.Literals([
  "loopback",
  "lan",
  "private-network",
  "public",
]);
export type AdvertisedEndpointReachability = typeof AdvertisedEndpointReachability.Type;

export const AdvertisedEndpointHostedHttpsCompatibility = Schema.Literals([
  "compatible",
  "mixed-content-blocked",
  "requires-configuration",
  "unknown",
]);
export type AdvertisedEndpointHostedHttpsCompatibility =
  typeof AdvertisedEndpointHostedHttpsCompatibility.Type;

export const AdvertisedEndpointStatus = Schema.Literals(["available", "unavailable", "unknown"]);
export type AdvertisedEndpointStatus = typeof AdvertisedEndpointStatus.Type;

export const AdvertisedEndpointSource = Schema.Literals([
  "desktop-core",
  "desktop-addon",
  "server",
  "user",
]);
export type AdvertisedEndpointSource = typeof AdvertisedEndpointSource.Type;

export const AdvertisedEndpointProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: AdvertisedEndpointProviderKind,
  isAddon: Schema.Boolean,
});
export type AdvertisedEndpointProvider = typeof AdvertisedEndpointProvider.Type;

export const AdvertisedEndpointCompatibility = Schema.Struct({
  hostedHttpsApp: AdvertisedEndpointHostedHttpsCompatibility,
  desktopApp: Schema.Literals(["compatible", "unknown"]),
});
export type AdvertisedEndpointCompatibility = typeof AdvertisedEndpointCompatibility.Type;

export const AdvertisedEndpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  provider: AdvertisedEndpointProvider,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  reachability: AdvertisedEndpointReachability,
  compatibility: AdvertisedEndpointCompatibility,
  source: AdvertisedEndpointSource,
  status: AdvertisedEndpointStatus,
  isDefault: Schema.optional(Schema.Boolean),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type AdvertisedEndpoint = typeof AdvertisedEndpoint.Type;

export const RemoteServerKind = Schema.Literals(["external", "managed"]);
export type RemoteServerKind = typeof RemoteServerKind.Type;

/**
 * RemoteAgentRecord - A saved remote T3 agent provisioned over SSH from a
 * headless control plane. Intentionally free of pairing secrets; pairing tokens
 * are one-time and printed at provisioning time, never persisted.
 */
export const RemoteAgentRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  alias: TrimmedNonEmptyString,
  target: RemoteSshTargetSchema,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  remoteServerKind: Schema.NullOr(RemoteServerKind),
  createdAt: TrimmedNonEmptyString,
  lastSeenAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type RemoteAgentRecord = typeof RemoteAgentRecord.Type;

export const REMOTE_AGENT_REGISTRY_VERSION = 1;

export const RemoteAgentRegistryFile = Schema.Struct({
  version: Schema.Literal(REMOTE_AGENT_REGISTRY_VERSION),
  agents: Schema.Array(RemoteAgentRecord),
});
export type RemoteAgentRegistryFile = typeof RemoteAgentRegistryFile.Type;

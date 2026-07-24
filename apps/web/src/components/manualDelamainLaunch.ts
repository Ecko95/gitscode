import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type RepositoryProfile,
  type RepositoryProfilesSettings,
} from "@t3tools/contracts";
import { resolveRepositoryProviderInstance } from "@t3tools/shared/repositoryProfiles";

import type { ProviderInstanceEntry } from "~/providerInstances";

export const DELAMAIN_SPAWN_ENGINES = ["codex", "cursor"] as const;
// Delamain's workflow command has one parent environment and no per-leaf engine selector.
// Keep routed workflows Codex-only until the protocol can pin every leaf explicitly.
const DELAMAIN_WORKFLOW_ENGINES = ["codex"] as const;
export type ManualDelamainEngine = (typeof DELAMAIN_SPAWN_ENGINES)[number];
export type ManualDelamainLaunchMode = "spawn" | "workflow";

export function manualDelamainEnginesForMode(
  mode: ManualDelamainLaunchMode,
): ReadonlyArray<ManualDelamainEngine> {
  return mode === "workflow" ? DELAMAIN_WORKFLOW_ENGINES : DELAMAIN_SPAWN_ENGINES;
}

export interface ManualDelamainLaunchRoute {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly requiresWorkPersonalConfirmation: boolean;
  readonly error: string | null;
}

export function resolveManualDelamainLaunchRoute(input: {
  readonly repositoryProfile: RepositoryProfile;
  readonly engine: ManualDelamainEngine;
  readonly profiles: RepositoryProfilesSettings;
  readonly instanceEntries: ReadonlyArray<
    Pick<ProviderInstanceEntry, "instanceId" | "driverKind" | "enabled" | "isAvailable">
  >;
}): ManualDelamainLaunchRoute {
  const driver = ProviderDriverKind.make(input.engine);
  const providerInstanceId = resolveRepositoryProviderInstance({
    repositoryProfile: input.repositoryProfile,
    driver,
    profiles: input.profiles,
  });
  if (providerInstanceId === null) {
    return {
      providerInstanceId: null,
      requiresWorkPersonalConfirmation: false,
      error: `No ${input.engine} account is mapped for this ${input.repositoryProfile} repository.`,
    };
  }
  const instance = input.instanceEntries.find((entry) => entry.instanceId === providerInstanceId);
  if (!instance || !instance.enabled || !instance.isAvailable || instance.driverKind !== driver) {
    return {
      providerInstanceId: null,
      requiresWorkPersonalConfirmation: false,
      error: `Mapped ${input.engine} account '${providerInstanceId}' is unavailable.`,
    };
  }
  const personalInstanceId = resolveRepositoryProviderInstance({
    repositoryProfile: "personal",
    driver,
    profiles: input.profiles,
  });
  return {
    providerInstanceId,
    requiresWorkPersonalConfirmation:
      input.repositoryProfile === "work" && personalInstanceId === providerInstanceId,
    error: null,
  };
}

export function manualDelamainPersonalWorkConfirmationMessage(accountLabel: string): string {
  return [
    `${accountLabel} is the Personal account for this Work repository.`,
    "Starting this worker will spend Personal usage.",
    "Continue for this launch only?",
  ].join("\n");
}

export async function executeManualDelamainLaunch(input: {
  readonly route: ManualDelamainLaunchRoute;
  readonly confirm: () => Promise<boolean>;
  readonly launch: (providerInstanceId: ProviderInstanceId) => Promise<void>;
}): Promise<boolean> {
  if (input.route.error || input.route.providerInstanceId === null) {
    throw new Error(input.route.error ?? "No provider account is selected for this launch.");
  }
  if (input.route.requiresWorkPersonalConfirmation && !(await input.confirm())) {
    return false;
  }
  await input.launch(input.route.providerInstanceId);
  return true;
}

export function startManualDelamainLaunch(
  input: Parameters<typeof executeManualDelamainLaunch>[0],
  onError: (error: unknown) => void,
): void {
  void executeManualDelamainLaunch(input).catch(onError);
}

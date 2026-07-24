import type {
  ProviderDriverKind,
  ProviderInstanceId,
  RepositoryProfile,
  RepositoryProfilesSettings,
} from "@t3tools/contracts";
import { isPathWithin } from "./path.ts";

export function resolveRepositoryProfile(input: {
  readonly workspaceRoot: string | null | undefined;
  readonly repositoryProfileOverride?: RepositoryProfile | null | undefined;
  readonly profiles: RepositoryProfilesSettings;
}): RepositoryProfile {
  if (input.repositoryProfileOverride) {
    return input.repositoryProfileOverride;
  }
  const workspaceRoot = input.workspaceRoot;
  if (!workspaceRoot) {
    return "personal";
  }
  return input.profiles.workRoots.some((root) => isPathWithin(workspaceRoot, root))
    ? "work"
    : "personal";
}

export function resolveRepositoryProviderInstance(input: {
  readonly repositoryProfile: RepositoryProfile;
  readonly driver: ProviderDriverKind;
  readonly profiles: RepositoryProfilesSettings;
  readonly controlPlane?: boolean | undefined;
}): ProviderInstanceId | null {
  return (
    input.profiles.providerInstances[input.controlPlane ? "personal" : input.repositoryProfile][
      input.driver
    ] ?? null
  );
}

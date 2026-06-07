import type {
  GitsMcpServerProvider,
  GitsSkillInventoryItem,
  GitsSkillInventorySnapshot,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

/**
 * Map a GITS skill inventory item into the {@link ServerProviderSkill} shape consumed by the
 * composer `$skill` autocomplete. GITS-inventoried skills are surfaced as enabled so that they
 * appear in the menu alongside the live provider `skills/list` results.
 */
export function mapGitsSkillToProviderSkill(item: GitsSkillInventoryItem): ServerProviderSkill {
  return {
    name: item.name,
    path: item.path,
    enabled: true,
    displayName: item.title,
    description: item.description ?? undefined,
    scope: item.provider,
  };
}

/**
 * Merge live provider skills with GITS-inventoried skills, keeping provider entries first
 * (they are runtime-validated and enabled) and appending inventory-only skills de-duped by name.
 */
export function mergeProviderAndInventorySkills(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  inventorySkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seen = new Set(providerSkills.map((skill) => skill.name.toLowerCase()));
  const merged = [...providerSkills];
  for (const skill of inventorySkills) {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(skill);
  }
  return merged;
}

/**
 * Read-only hook that fetches the cross-provider GITS skill inventory and maps it into the
 * composer skill shape. Fails soft: returns an empty array when the endpoint is unavailable so
 * the composer falls back to live provider skills only.
 */
export function useGitsSkillInventory(
  providerFilter?: GitsMcpServerProvider | null,
): ServerProviderSkill[] {
  const inventoryQuery = useQuery({
    queryKey: ["gits", "skills", "composer"],
    queryFn: async (): Promise<GitsSkillInventorySnapshot> => {
      const response = await fetch("/api/gits/skills", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Skills inventory request failed with ${response.status}.`);
      }
      return (await response.json()) as GitsSkillInventorySnapshot;
    },
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  });

  const skills = inventoryQuery.data?.skills ?? [];
  return skills
    .filter((item) => (providerFilter ? item.provider === providerFilter : true))
    .map(mapGitsSkillToProviderSkill);
}

import { TurnId } from "@t3tools/contracts";

export interface DiffRouteSearch {
  diff?: "1" | "crit" | undefined;
  browser?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffTurnId" | "diffFilePath"> {
  const { diff: _diff, diffTurnId: _diffTurnId, diffFilePath: _diffFilePath, ...rest } = params;
  return rest as Omit<T, "diff" | "diffTurnId" | "diffFilePath">;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : search.diff === "crit" ? "crit" : undefined;
  const browser = isDiffOpenValue(search.browser) ? "1" : undefined;
  // diffTurnId/diffFilePath only apply to the native per-turn diff, not crit.
  const diffTurnIdRaw = diff === "1" ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath =
    diff === "1" && diffTurnId ? normalizeSearchString(search.diffFilePath) : undefined;

  return {
    ...(diff && !browser ? { diff } : {}),
    ...(browser ? { browser } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
  };
}

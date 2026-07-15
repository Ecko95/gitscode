import type {
  ProviderDriverKind,
  UsageProvider,
  UsageSummary,
  UsageWindowSummary,
} from "@t3tools/contracts";

export async function readUsageSummary(): Promise<UsageSummary> {
  const response = await fetch("/api/gits/usage", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Usage request failed with ${response.status}.`);
  return (await response.json()) as UsageSummary;
}

export function usageProviderForDriver(driver: ProviderDriverKind | null): UsageProvider | null {
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claude";
  return null;
}

export function selectProviderUsageWindows(
  summary: Pick<UsageSummary, "windows"> | undefined,
  provider: UsageProvider,
): { fiveHour: UsageWindowSummary | null; weekly: UsageWindowSummary | null } {
  const windows = summary?.windows.filter((window) => window.provider === provider) ?? [];
  return {
    fiveHour: windows.find((window) => window.windowMinutes === 300) ?? null,
    weekly: windows.find((window) => window.windowMinutes === 10080) ?? null,
  };
}

export function clampUsagePercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

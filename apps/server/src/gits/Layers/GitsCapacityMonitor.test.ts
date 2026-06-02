// @effect-diagnostics nodeBuiltinImport:off

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readCodexUsageFromHome,
  readCursorDashboardTelemetry,
  recommendDelamainEngine,
  usageLevelFromRemaining,
} from "./GitsCapacityMonitor.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gits-capacity-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("GitsCapacityMonitor", () => {
  it("reads Codex 5h and weekly rate limits from local session JSONL", () => {
    const home = makeTempDir();
    const sessionDir = join(home, "sessions", "2026", "05", "31");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "rollout.jsonl"),
      `${JSON.stringify({
        payload: {
          rate_limits: {
            primary: {
              used_percent: 82,
              window_minutes: 300,
              reset_at: 1_800_000_000,
            },
            secondary: {
              used_percent: 34,
              window_minutes: 10080,
              reset_at: 1_800_100_000,
            },
            plan_type: "pro",
          },
        },
      })}\n`,
      "utf8",
    );

    const usage = readCodexUsageFromHome(home);

    expect(usage?.source).toBe("codex-session-jsonl");
    expect(usage?.limits.map((limit) => limit.label)).toEqual(["5h", "weekly"]);
    expect(usage?.limits[0]?.usedPercent).toBe(82);
    expect(usage?.limits[0]?.remainingPercent).toBe(18);
    expect(usage?.limits[0]?.level).toBe("critical");
  });

  it("recommends Cursor when Codex is constrained and Cursor has budget headroom", () => {
    const codex = {
      provider: "codex" as const,
      displayName: "Codex",
      status: "available" as const,
      source: "codex-session-jsonl" as const,
      accountLabel: null,
      planLabel: "pro",
      windows: [
        {
          label: "5h",
          usedPercent: 88,
          remainingPercent: 12,
          windowMinutes: 300,
          resetAt: null,
          level: usageLevelFromRemaining(12),
          source: "codex-session-jsonl" as const,
          note: null,
        },
      ],
      monthlyBudgetUsd: null,
      monthlySpendUsd: null,
      monthlyUtilizationPercent: null,
      monthlyRemainingUsd: null,
      monthlyResetAt: null,
      note: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const cursor = {
      provider: "cursor" as const,
      displayName: "Cursor",
      status: "available" as const,
      source: "cursor-cli" as const,
      accountLabel: "operator@example.com",
      planLabel: "Enterprise",
      windows: [
        {
          label: "monthly",
          usedPercent: 10,
          remainingPercent: 90,
          windowMinutes: null,
          resetAt: null,
          level: "green" as const,
          source: "manual-config" as const,
          note: null,
        },
      ],
      monthlyBudgetUsd: 500,
      monthlySpendUsd: 50,
      monthlyUtilizationPercent: 10,
      monthlyRemainingUsd: 450,
      monthlyResetAt: null,
      note: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const recommendation = recommendDelamainEngine(codex, cursor);

    expect(recommendation.recommendedEngine).toBe("cursor");
    expect(recommendation.confidence).toBe("high");
  });

  it("reads Cursor dashboard spend from Workos session cookie without persisting it", async () => {
    vi.stubEnv("GITS_CURSOR_WORKOS_TOKEN", "secret-cookie-value");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/api/auth/me")) {
          return Response.json({ sub: "user-sub", email: "joshua.duffill@bts.com" });
        }
        if (url.includes("/api/usage?user=user-sub")) {
          return Response.json({
            startOfMonth: "2026-05-01T00:00:00.000Z",
            "gpt-4": {
              maxRequestUsage: 500,
              numRequests: 25,
            },
          });
        }
        if (url.endsWith("/api/dashboard/teams")) {
          return Response.json({ teams: [{ id: 123 }] });
        }
        if (url.endsWith("/api/dashboard/team")) {
          return Response.json({ userId: "team-user" });
        }
        if (url.endsWith("/api/dashboard/get-team-spend")) {
          return Response.json({
            teamMemberSpend: [
              {
                userId: "team-user",
                spendCents: 2374,
                hardLimitOverrideDollars: 500,
                fastPremiumRequests: 42,
              },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const telemetry = await readCursorDashboardTelemetry();

    expect(telemetry?.source).toBe("cursor-dashboard-cookie");
    expect(telemetry?.accountLabel).toBe("joshua.duffill@bts.com");
    expect(telemetry?.spendUsd).toBe(23.74);
    expect(telemetry?.budgetUsd).toBe(500);
    expect(telemetry?.resetAt).toBe("2026-06-01T00:00:00.000Z");
    expect(JSON.stringify(telemetry)).not.toContain("secret-cookie-value");
  });
});

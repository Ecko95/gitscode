import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  resolveRepositoryProfile,
  resolveRepositoryProviderInstance,
} from "@t3tools/shared/repositoryProfiles";
import { describe, expect, it } from "vitest";

const profiles = {
  workRoots: ["/Users/agent/work", "C:\\Work"],
  providerInstances: {
    personal: {
      codex: ProviderInstanceId.make("codex-personal"),
      cursor: ProviderInstanceId.make("cursor-personal"),
      claudeAgent: ProviderInstanceId.make("claude-personal"),
    },
    work: {
      codex: ProviderInstanceId.make("codex-work"),
      cursor: ProviderInstanceId.make("cursor-work"),
      claudeAgent: ProviderInstanceId.make("claude-personal"),
    },
  },
} as const;

describe("repository profiles", () => {
  it("defaults repositories outside work roots to Personal", () => {
    expect(resolveRepositoryProfile({ workspaceRoot: "/Users/agent/personal/app", profiles })).toBe(
      "personal",
    );
  });

  it("classifies a workspace within a Work root as Work", () => {
    expect(resolveRepositoryProfile({ workspaceRoot: "/Users/agent/work/app", profiles })).toBe(
      "work",
    );
  });

  it("rejects paths that only share a Work root textual prefix", () => {
    expect(resolveRepositoryProfile({ workspaceRoot: "/Users/agent/workshop/app", profiles })).toBe(
      "personal",
    );
  });

  it("normalizes slash styles before classifying a workspace", () => {
    expect(resolveRepositoryProfile({ workspaceRoot: "/Users/agent/work\\app", profiles })).toBe(
      "work",
    );
  });

  it("matches Windows workspace paths without case sensitivity", () => {
    expect(resolveRepositoryProfile({ workspaceRoot: "c:\\work\\App", profiles })).toBe("work");
  });

  it("ignores non-absolute Work roots", () => {
    expect(
      resolveRepositoryProfile({
        workspaceRoot: "c:/repo",
        profiles: { ...profiles, workRoots: ["c:", "repo", "~/work"] },
      }),
    ).toBe("personal");
  });

  it("uses an explicit repository profile over path classification", () => {
    expect(
      resolveRepositoryProfile({
        workspaceRoot: "/Users/agent/work/app",
        repositoryProfileOverride: "personal",
        profiles,
      }),
    ).toBe("personal");
  });

  it("returns null when a repository profile has no route for a driver", () => {
    expect(
      resolveRepositoryProviderInstance({
        repositoryProfile: "work",
        driver: ProviderDriverKind.make("opencode"),
        profiles,
      }),
    ).toBeNull();
  });

  it("routes Work Codex and Cursor sessions to their Work instances", () => {
    expect(
      resolveRepositoryProviderInstance({
        repositoryProfile: "work",
        driver: ProviderDriverKind.make("codex"),
        profiles,
      }),
    ).toBe("codex-work");
    expect(
      resolveRepositoryProviderInstance({
        repositoryProfile: "work",
        driver: ProviderDriverKind.make("cursor"),
        profiles,
      }),
    ).toBe("cursor-work");
  });

  it("routes Work Claude sessions to the configured Personal instance", () => {
    expect(
      resolveRepositoryProviderInstance({
        repositoryProfile: "work",
        driver: ProviderDriverKind.make("claudeAgent"),
        profiles,
      }),
    ).toBe("claude-personal");
  });
});

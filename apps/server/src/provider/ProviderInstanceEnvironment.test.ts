import { describe, expect, it } from "vitest";

import { buildChildEnv, mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

describe("buildChildEnv", () => {
  // Simulates a polluted server process.env (API keys from unrelated services, etc.)
  const pollutedEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    ANTHROPIC_API_KEY: "sk-ant-real",
    CLAUDE_SETTINGS_SOMETHING: "val",
    OPENAI_API_KEY: "sk-openai-real",
    CODEX_HOME: "/home/user/.codex",
    CURSOR_SESSION_TOKEN: "cursor-tok",
    OPENCODE_CONFIG_CONTENT: "{}",
    NODE_EXTRA_CA_CERTS: "/etc/certs.pem",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    XDG_CONFIG_HOME: "/home/user/.config",
    GITS_RTK_BIN: "/usr/local/bin/rtk",
    RTK_BIN: "/usr/local/bin/rtk",
    GITS_RTK_REWRITE_TOOLS: "1",
    // --- must be excluded ---
    SPLITWISE_API_KEY: "sw-secret",
    GITHUB_TOKEN: "ghp_secret",
    DATABASE_URL: "postgres://...",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SLACK_BOT_TOKEN: "xoxb-secret",
    MY_RANDOM_SECRET: "super-secret",
  };

  it("passes allowed vars through", () => {
    const child = buildChildEnv(pollutedEnv);
    expect(child.PATH).toBe("/usr/bin:/bin");
    expect(child.HOME).toBe("/home/user");
    expect(child.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(child.CLAUDE_SETTINGS_SOMETHING).toBe("val");
    expect(child.OPENAI_API_KEY).toBe("sk-openai-real");
    expect(child.CODEX_HOME).toBe("/home/user/.codex");
    expect(child.CURSOR_SESSION_TOKEN).toBe("cursor-tok");
    expect(child.OPENCODE_CONFIG_CONTENT).toBe("{}");
    expect(child.NODE_EXTRA_CA_CERTS).toBe("/etc/certs.pem");
    expect(child.LANG).toBe("en_US.UTF-8");
    expect(child.LC_ALL).toBe("en_US.UTF-8");
    expect(child.XDG_CONFIG_HOME).toBe("/home/user/.config");
    expect(child.GITS_RTK_BIN).toBe("/usr/local/bin/rtk");
    expect(child.RTK_BIN).toBe("/usr/local/bin/rtk");
    expect(child.GITS_RTK_REWRITE_TOOLS).toBe("1");
  });

  it("excludes unrelated credentials from child env", () => {
    const child = buildChildEnv(pollutedEnv);
    expect(child).not.toHaveProperty("SPLITWISE_API_KEY");
    expect(child).not.toHaveProperty("GITHUB_TOKEN");
    expect(child).not.toHaveProperty("DATABASE_URL");
    expect(child).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(child).not.toHaveProperty("SLACK_BOT_TOKEN");
    expect(child).not.toHaveProperty("MY_RANDOM_SECRET");
  });

  it("explicit injections in mergeProviderInstanceEnvironment still take effect", () => {
    const child = mergeProviderInstanceEnvironment(
      [{ name: "CODEX_HOME", value: "/custom/.codex", sensitive: false }],
      buildChildEnv(pollutedEnv),
    );
    expect(child.CODEX_HOME).toBe("/custom/.codex");
    // Other allowlisted vars still present
    expect(child.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    // Unrelated secrets still absent
    expect(child).not.toHaveProperty("SPLITWISE_API_KEY");
  });
});

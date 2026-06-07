import { describe, expect, it } from "vitest";
import { build_crit_spawn_spec } from "./crit-sidecar-manager.ts";

describe("build_crit_spawn_spec", () => {
  it("binds to loopback and wires agent_cmd env for the wrapper", () => {
    const spec = build_crit_spawn_spec({
      binaryPath: "/opt/crit",
      repoRoot: "/work/repo",
      branch: "feature/x",
      host: "127.0.0.1",
      port: 4321,
      origin: "http://127.0.0.1:4310",
      token: "scoped-token",
      threadId: "thread-1",
      wrapperCommand: "node /app/crit-agent-cli.js",
    });

    expect(spec.command).toBe("/opt/crit");
    expect(spec.args).toContain("127.0.0.1");
    expect(spec.args).toContain("4321");
    expect(spec.args).toContain("/work/repo");
    expect(spec.args).toContain("node /app/crit-agent-cli.js");
    expect(spec.env.GITS_ORIGIN).toBe("http://127.0.0.1:4310");
    expect(spec.env.GITS_TOKEN).toBe("scoped-token");
    expect(spec.env.GITS_THREAD_ID).toBe("thread-1");
    expect(spec.url).toBe("http://127.0.0.1:4321");
  });
});

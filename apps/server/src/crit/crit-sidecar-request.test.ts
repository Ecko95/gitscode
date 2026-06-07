import { describe, expect, it } from "vitest";

import { build_ensure_sidecar_input } from "./crit-sidecar-request.ts";

describe("build_ensure_sidecar_input", () => {
  const base = {
    request: {
      workspaceRoot: "/home/me/project",
      branch: "feat/crit",
      threadId: "thread-123",
    },
    origin: "http://127.0.0.1:7331",
    wrapperCommand: "node /opt/crit/crit-agent-cli.js",
    binaryPath: "/opt/crit/bin/crit",
  };

  it("assembles the full EnsureCritSidecarInput from the request + context", () => {
    const input = build_ensure_sidecar_input(base);

    expect(input).toEqual({
      workspaceRoot: "/home/me/project",
      branch: "feat/crit",
      threadId: "thread-123",
      origin: "http://127.0.0.1:7331",
      wrapperCommand: "node /opt/crit/crit-agent-cli.js",
      binaryPath: "/opt/crit/bin/crit",
      host: "127.0.0.1",
    });
  });

  it("defaults the host to loopback", () => {
    expect(build_ensure_sidecar_input(base).host).toBe("127.0.0.1");
  });

  it("carries the server-resolved origin verbatim (the token is minted in the manager)", () => {
    const input = build_ensure_sidecar_input({
      ...base,
      origin: "http://127.0.0.1:9999",
    });
    expect(input.origin).toBe("http://127.0.0.1:9999");
    expect(input).not.toHaveProperty("token");
  });
});

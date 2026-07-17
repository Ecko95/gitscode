import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeGitsMcpInventoryResolver } from "./GitsMcpInventory.ts";

describe("GitsMcpInventoryResolverLive", () => {
  it.effect("parses Codex TOML and Claude/Cursor JSON MCP config read-only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-gits-mcp-",
      });
      const codexConfig = path.join(tempDir, "config.toml");
      const claudeConfig = path.join(tempDir, ".claude.json");
      const cursorConfig = path.join(tempDir, "mcp.json");

      yield* fileSystem.writeFileString(
        codexConfig,
        [
          'model = "gpt-5"',
          "",
          "[mcp_servers.context7]",
          'command = "npx"',
          'args = ["-y", "@upstash/context7-mcp"]',
          "",
          "[mcp_servers.disabled-one]",
          'command = "node"',
          "enabled = false",
        ].join("\n"),
      );
      yield* fileSystem.writeFileString(
        claudeConfig,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          mcpServers: {
            linear: { url: "https://mcp.linear.app/sse", type: "sse" },
            local: { command: "bun", args: ["run", "mcp"], disabled: true },
          },
        }),
      );

      const resolver = makeGitsMcpInventoryResolver({
        now: () => "2026-06-02T10:00:00.000Z",
        configTargets: [
          { provider: "codex", filePath: codexConfig, format: "toml" },
          { provider: "claude", filePath: claudeConfig, format: "json" },
          { provider: "cursor", filePath: cursorConfig, format: "json" },
        ],
      });
      const snapshot = yield* resolver.getSnapshot();

      expect(snapshot.scannedAt).toBe("2026-06-02T10:00:00.000Z");
      expect(snapshot.totals.serverCount).toBe(4);
      expect(snapshot.totals.disabledCount).toBe(2);

      const context7 = snapshot.servers.find((server) => server.name === "context7");
      expect(context7?.provider).toBe("codex");
      expect(context7?.command).toBe("npx -y @upstash/context7-mcp");
      expect(context7?.transport).toBe("stdio");
      expect(context7?.enabled).toBe(true);

      const linear = snapshot.servers.find((server) => server.name === "linear");
      expect(linear?.provider).toBe("claude");
      expect(linear?.transport).toBe("sse");
      expect(linear?.command).toBe("https://mcp.linear.app/sse");

      const disabled = snapshot.servers.find((server) => server.name === "disabled-one");
      expect(disabled?.enabled).toBe(false);
      expect(disabled?.status).toBe("disabled");

      expect(snapshot.providers.map((provider) => provider.provider).sort()).toEqual([
        "claude",
        "codex",
      ]);
      expect(snapshot.warnings.some((warning) => warning.includes("cursor"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("merges redacted Codex runtime auth status without dropping config fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-gits-mcp-runtime-",
      });
      const codexConfig = path.join(tempDir, "config.toml");

      yield* fileSystem.writeFileString(
        codexConfig,
        [
          "[mcp_servers.supabase]",
          'url = "https://mcp.supabase.com/mcp"',
          "",
          "[mcp_servers.config-only]",
          'command = "node"',
        ].join("\n"),
      );

      const resolver = makeGitsMcpInventoryResolver({
        now: () => "2026-06-02T10:00:00.000Z",
        configTargets: [{ provider: "codex", filePath: codexConfig, format: "toml" }],
        getRuntimeServers: () =>
          Effect.succeed([
            {
              providerInstanceId: "codex",
              name: "supabase",
              authStatus: "notLoggedIn",
              tools: ["query"],
              resourceCount: 2,
              // Unknown fields model data a provider response must never project.
              authorizationUrl: "https://auth.example.test/?code=secret",
              accessToken: "secret-token",
            },
          ]),
      });
      const snapshot = yield* resolver.getSnapshot();

      const supabase = snapshot.servers.find((server) => server.name === "supabase");
      expect(supabase).toMatchObject({
        provider: "codex",
        providerInstanceId: "codex",
        source: "config-file",
        runtimeSource: "codex-app-server",
        runtimeStatus: "running",
        status: "running",
        authStatus: "unauthenticated",
        canAuthenticate: true,
        toolCount: 1,
        resourceCount: 2,
        tools: ["query"],
      });
      expect(snapshot.servers.find((server) => server.name === "config-only")).toMatchObject({
        source: "config-file",
        status: "unknown",
        authStatus: "unknown",
        canAuthenticate: false,
      });
      expect(Object.hasOwn(supabase ?? {}, "authorizationUrl")).toBe(false);
      expect(Object.hasOwn(supabase ?? {}, "accessToken")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

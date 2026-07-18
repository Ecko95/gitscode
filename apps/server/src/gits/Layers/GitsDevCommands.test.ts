// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import { makeGitsDevCommandsService } from "./GitsDevCommands.ts";

const runnerPath = "/gits-state/gits/dev-command-runner.sh";

async function makeProject(packageJson: unknown): Promise<string> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-dev-commands-"));
  await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify(packageJson));
  return projectDir;
}

it("keeps inferred dev commands private and does not claim a port", async () => {
  const projectDir = await makeProject({
    name: "example-web",
    scripts: { "dev:web": "vite" },
  });
  try {
    const commands = makeGitsDevCommandsService({ runnerPath });
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.localPort).toBeNull();
    expect(result.commands[0]?.publishOnTailnet).toBe(false);
    expect(result.commands[0]?.previewUrl).toBeNull();
    expect(result.commands[0]?.launchCommand).toContain(runnerPath);
    expect(result.commands[0]?.launchCommand).not.toContain(
      path.join(projectDir, "scripts", "dev", "run-dev-command.sh"),
    );
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

it("does not assume a port for an inferred root dev script", async () => {
  const projectDir = await makeProject({ scripts: { dev: "bun run --filter '*' dev" } });
  try {
    const commands = makeGitsDevCommandsService({ runnerPath });
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands[0]).toMatchObject({ localHost: null, localPort: null });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

it("uses the owned runner and disables legacy Tailnet publishing", async () => {
  const projectDir = await makeProject({ scripts: {} });
  try {
    await fs.mkdir(path.join(projectDir, ".gits"));
    await fs.writeFile(
      path.join(projectDir, ".gits", "dev-commands.json"),
      JSON.stringify({
        commands: [
          {
            id: "web-dev",
            name: "Web dev",
            command: "vite",
            port: 5173,
            host: "127.0.0.1",
            publishOnTailnet: true,
            servePort: 8443,
          },
        ],
      }),
    );
    const commands = makeGitsDevCommandsService({ runnerPath });
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands[0]).toMatchObject({
      localPort: 5173,
      publishOnTailnet: false,
      servePort: null,
      previewUrl: null,
    });
    expect(result.commands[0]?.launchCommand).toContain(runnerPath);
    expect(result.commands[0]?.launchCommand).toContain(
      "GITS_DEV_COMMAND='vite --host 127.0.0.1 --port 5173 --strictPort'",
    );
    expect(result.commands[0]?.launchCommand).not.toContain("GITS_DEV_PUBLISH_TAILNET");
    expect(result.warnings.join(" ")).toContain("Tailnet publishing is unavailable");
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

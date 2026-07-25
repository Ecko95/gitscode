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

it("does not assume a port for an inferred root dev script but binds IPv4 loopback", async () => {
  const projectDir = await makeProject({ scripts: { dev: "bun run --filter '*' dev" } });
  try {
    const commands = makeGitsDevCommandsService({ runnerPath });
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands[0]).toMatchObject({ localHost: "127.0.0.1", localPort: null });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

it("injects configured allowed hosts into the launch command", async () => {
  const projectDir = await makeProject({ scripts: { dev: "vite" } });
  try {
    const commands = makeGitsDevCommandsService({
      runnerPath,
      allowedHosts: ".taild6d729.ts.net",
      bindHost: "127.0.0.1",
    });
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands[0]?.launchCommand).toContain(
      "GITS_DEV_ALLOWED_HOSTS='.taild6d729.ts.net'",
    );
    // Surfaced in the cockpit so a 403 is diagnosable without reading the env.
    expect(result).toMatchObject({ allowedHosts: [".taild6d729.ts.net"], bindHost: "127.0.0.1" });
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

it("lets the project config override the server-wide dev settings", async () => {
  const projectDir = await makeProject({ scripts: {} });
  try {
    await fs.mkdir(path.join(projectDir, ".gits"));
    await fs.writeFile(
      path.join(projectDir, ".gits", "dev-commands.json"),
      JSON.stringify({
        dev: { allowedHosts: ["app.taild6d729.ts.net"], bindHost: "0.0.0.0" },
        commands: [{ id: "web-dev", name: "Web dev", command: "vite", port: 5173 }],
      }),
    );
    const commands = makeGitsDevCommandsService({
      runnerPath,
      allowedHosts: ".other.ts.net",
    });
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands[0]?.localHost).toBe("0.0.0.0");
    expect(result.commands[0]?.launchCommand).toContain(
      "GITS_DEV_ALLOWED_HOSTS='app.taild6d729.ts.net'",
    );
    expect(result.commands[0]?.launchCommand).toContain("--host 0.0.0.0 --port 5173 --strictPort");
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

it("publishes on the tailnet only when the server enables it", async () => {
  const projectDir = await makeProject({ scripts: {} });
  const config = {
    commands: [
      {
        id: "web-dev",
        name: "Web dev",
        command: "vite",
        port: 5173,
        publishOnTailnet: true,
        servePort: 8444,
      },
    ],
  };
  try {
    await fs.mkdir(path.join(projectDir, ".gits"));
    await fs.writeFile(path.join(projectDir, ".gits", "dev-commands.json"), JSON.stringify(config));

    const disabled = await Effect.runPromise(
      makeGitsDevCommandsService({ runnerPath }).listCommands({ projectDir }),
    );
    expect(disabled.commands[0]).toMatchObject({ publishOnTailnet: false, servePort: null });
    expect(disabled.commands[0]?.launchCommand).not.toContain("GITS_DEV_SERVE_PORT");
    expect(disabled.warnings.join(" ")).toContain("Tailnet publishing is disabled");

    const enabled = await Effect.runPromise(
      makeGitsDevCommandsService({
        runnerPath,
        tailscaleServeEnabled: true,
        magicDnsName: "vps-eu.taild6d729.ts.net",
      }).listCommands({ projectDir }),
    );
    expect(enabled.commands[0]).toMatchObject({
      publishOnTailnet: true,
      servePort: 8444,
      previewUrl: "https://vps-eu.taild6d729.ts.net:8444/",
    });
    expect(enabled.commands[0]?.launchCommand).toContain("GITS_DEV_SERVE_PORT='8444'");
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

it("uses the owned runner and keeps unconfigured Tailnet publishing off", async () => {
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
    expect(result.commands[0]?.launchCommand).not.toContain("GITS_DEV_SERVE_PORT");
    expect(result.warnings.join(" ")).toContain("Tailnet publishing is disabled");
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

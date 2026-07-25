// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  materializeDevCommandRunner,
  parseAllowedHosts,
  withStrictPortArgs,
} from "./dev-command-runner.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("materializes the runner under GITS state and only serves on request", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-dev-runner-"));
  tempDirs.push(stateDir);

  const runnerPath = await materializeDevCommandRunner(stateDir);
  const contents = await fs.readFile(runnerPath, "utf8");

  expect(runnerPath).toBe(path.join(stateDir, "gits", "dev-command-runner.sh"));
  expect(contents).toContain("Port ${local_host}:${local_port} is already in use");
  // Tailnet publishing only runs when the caller passes an explicit serve port.
  expect(contents).toContain('if [[ -n "${serve_port}" ]]; then');
  expect(contents).toContain("tailscale serve --bg");
});

it("injects allowed hosts and the bind host into the dev server environment", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-dev-runner-"));
  tempDirs.push(stateDir);
  const runnerPath = await materializeDevCommandRunner(stateDir);

  const { stdout } = await execFileAsync("bash", [runnerPath], {
    env: {
      ...process.env,
      GITS_DEV_CWD: stateDir,
      GITS_DEV_COMMAND:
        'printf "%s|%s|%s\\n" "$__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS" "$GITS_DEV_ALLOWED_HOSTS" "$HOST"',
      GITS_DEV_LOCAL_HOST: "127.0.0.1",
      GITS_DEV_ALLOWED_HOSTS: ".taild6d729.ts.net",
    },
  });

  expect(stdout).toContain(".taild6d729.ts.net|.taild6d729.ts.net|127.0.0.1");
});

it("keeps only hostname-shaped allowed host entries", () => {
  expect(parseAllowedHosts(" .taild6d729.ts.net , vps-eu ,, bad host ")).toEqual([
    ".taild6d729.ts.net",
    "vps-eu",
  ]);
  expect(parseAllowedHosts(["a.example.com", 'evil"host'])).toEqual(["a.example.com"]);
  expect(parseAllowedHosts(undefined)).toEqual([]);
});

it("preflights an explicitly claimed port before starting the command", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-dev-runner-"));
  tempDirs.push(stateDir);
  const markerPath = path.join(stateDir, "started");
  const runnerPath = await materializeDevCommandRunner(stateDir);
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener address.");

  try {
    await expect(
      execFileAsync("bash", [runnerPath], {
        env: {
          ...process.env,
          GITS_DEV_NAME: "Web dev",
          GITS_DEV_CWD: stateDir,
          GITS_DEV_COMMAND: `touch '${markerPath}'`,
          GITS_DEV_LOCAL_HOST: "127.0.0.1",
          GITS_DEV_LOCAL_PORT: String(address.port),
        },
      }),
    ).rejects.toMatchObject({ code: 78 });
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("adds strict port flags only to a directly configured Vite command", () => {
  expect(
    withStrictPortArgs({
      command: "vite",
      host: "127.0.0.1",
      port: 5173,
    }),
  ).toBe("vite --host 127.0.0.1 --port 5173 --strictPort");
  expect(
    withStrictPortArgs({
      command: "bun run dev",
      host: "127.0.0.1",
      port: 5173,
    }),
  ).toBe("bun run dev -- --host 127.0.0.1 --port 5173 --strictPort");
  expect(
    withStrictPortArgs({
      command: "make dev",
      host: "127.0.0.1",
      port: 5173,
    }),
  ).toBe("make dev");
});

// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { materializeDevCommandRunner, withStrictPortArgs } from "./dev-command-runner.ts";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("materializes the runner under GITS state without Tailnet side effects", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-dev-runner-"));
  tempDirs.push(stateDir);

  const runnerPath = await materializeDevCommandRunner(stateDir);
  const contents = await fs.readFile(runnerPath, "utf8");

  expect(runnerPath).toBe(path.join(stateDir, "gits", "dev-command-runner.sh"));
  expect(contents).toContain("Port ${local_host}:${local_port} is already in use");
  expect(contents).not.toContain("tailscale serve");
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
  ).toBe("bun run dev");
});

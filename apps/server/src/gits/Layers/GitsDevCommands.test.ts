// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import { makeGitsDevCommands } from "./GitsDevCommands.ts";

it("keeps inferred dev commands private", async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-dev-commands-"));
  try {
    await fs.writeFile(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "example-web", scripts: { "dev:web": "vite" } }),
    );
    const commands = await Effect.runPromise(makeGitsDevCommands);
    const result = await Effect.runPromise(commands.listCommands({ projectDir }));

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.localPort).toBe(3000);
    expect(result.commands[0]?.publishOnTailnet).toBe(false);
    expect(result.commands[0]?.previewUrl).toBeNull();
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

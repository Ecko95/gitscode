// @effect-diagnostics nodeBuiltinImport:off
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolve_crit_binary_path,
  resolve_crit_binary_relative_path,
} from "./crit-binary-resolver.ts";

describe("resolve_crit_binary_relative_path", () => {
  it("maps platform/arch to the bundled binary subpath", () => {
    expect(resolve_crit_binary_relative_path("darwin", "arm64")).toBe("crit/darwin-arm64/crit");
    expect(resolve_crit_binary_relative_path("linux", "x64")).toBe("crit/linux-x64/crit");
    expect(resolve_crit_binary_relative_path("win32", "x64")).toBe("crit/win32-x64/crit.exe");
  });
});

describe("resolve_crit_binary_path", () => {
  it("prefers an executable GITS_CRIT_BINARY override", () => {
    const dir = mkdtempSync(join(tmpdir(), "crit-bin-"));
    const bin = join(dir, "crit");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(
      resolve_crit_binary_path({ env: { GITS_CRIT_BINARY: bin }, resourcesPath: undefined }),
    ).toBe(bin);
  });

  it("falls back to bare 'crit' when nothing resolves", () => {
    expect(
      resolve_crit_binary_path({
        env: {},
        resourcesPath: "/nonexistent-xyz",
        platform: "linux",
        arch: "x64",
      }),
    ).toBe("crit");
  });
});

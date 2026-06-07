// @effect-diagnostics nodeBuiltinImport:off
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export function resolve_crit_binary_relative_path(platform: NodeJS.Platform, arch: string): string {
  const binary = platform === "win32" ? "crit.exe" : "crit";
  return `crit/${platform}-${arch}/${binary}`;
}

function is_executable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveCritBinaryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export function resolve_crit_binary_path(options: ResolveCritBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const override = env.GITS_CRIT_BINARY?.trim();
  if (override && is_executable(override)) {
    return override;
  }

  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const bundled = join(resourcesPath, resolve_crit_binary_relative_path(platform, arch));
    if (is_executable(bundled)) {
      return bundled;
    }
  }

  // Dev fallback: rely on PATH lookup by returning the bare command.
  return "crit";
}

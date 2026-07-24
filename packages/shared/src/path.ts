export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isExplicitRelativePath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

export function normalizePath(value: string): string {
  const slashNormalized = value.trim().replaceAll("\\", "/");
  const isUnc = slashNormalized.startsWith("//");
  const prefix = isUnc ? "//" : "";
  const collapsed = `${prefix}${slashNormalized.slice(isUnc ? 2 : 0).replace(/\/+/g, "/")}`;
  const withoutTrailingSlash = collapsed.replace(/(?<!^)\/$/, "");
  return isWindowsAbsolutePath(value) || isUnc
    ? withoutTrailingSlash.toLowerCase()
    : withoutTrailingSlash;
}

export function isPathWithin(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot) {
    return false;
  }
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`)
  );
}

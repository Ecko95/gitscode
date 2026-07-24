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
  const isDrive = /^[a-zA-Z]:\//.test(slashNormalized);
  const isAbsolute = isUnc || isDrive || slashNormalized.startsWith("/");
  const rawSegments = slashNormalized.split("/");
  const rootSegments = isUnc ? rawSegments.slice(2, 4) : [];
  const segments = rawSegments.slice(isUnc ? 4 : isDrive ? 1 : isAbsolute ? 1 : 0);
  const normalizedSegments: Array<string> = [];

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalizedSegments.length > 0 && normalizedSegments.at(-1) !== "..") {
        normalizedSegments.pop();
      } else if (!isAbsolute) {
        normalizedSegments.push(segment);
      }
      continue;
    }
    normalizedSegments.push(segment);
  }

  const path = isUnc
    ? `//${rootSegments.join("/")}${normalizedSegments.length ? `/${normalizedSegments.join("/")}` : ""}`
    : isDrive
      ? `${slashNormalized.slice(0, 2)}/${normalizedSegments.join("/")}`
      : isAbsolute
        ? `/${normalizedSegments.join("/")}`
        : normalizedSegments.join("/") || (slashNormalized ? "." : "");
  return isWindowsAbsolutePath(value) || isUnc ? path.toLowerCase() : path;
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

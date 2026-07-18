export type EnvironmentUrlKind = "external" | "loopback" | "oauth-loopback";

const isHttpUrl = (url: URL) => url.protocol === "http:" || url.protocol === "https:";

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 127 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  );
}

export function normalizeLoopbackDisplayUrl(url: URL): URL {
  const normalized = new URL(url);
  if (normalized.hostname === "0.0.0.0") normalized.hostname = "127.0.0.1";
  if (normalized.hostname === "[::]" || normalized.hostname === "::") normalized.hostname = "[::1]";
  return normalized;
}

export function extractLoopbackRedirectUri(authorizationUrl: URL): URL | null {
  const rawRedirect = authorizationUrl.searchParams.get("redirect_uri");
  if (!rawRedirect) return null;
  try {
    const redirect = new URL(rawRedirect);
    return isHttpUrl(redirect) && isLoopbackHostname(redirect.hostname) ? redirect : null;
  } catch {
    return null;
  }
}

export function classifyEnvironmentUrl(rawUrl: string): {
  readonly url: URL;
  readonly kind: EnvironmentUrlKind;
} {
  const url = normalizeLoopbackDisplayUrl(new URL(rawUrl));
  if (!isHttpUrl(url)) throw new Error("Environment URLs must use HTTP or HTTPS.");
  if (extractLoopbackRedirectUri(url)) return { url, kind: "oauth-loopback" };
  return { url, kind: isLoopbackHostname(url.hostname) ? "loopback" : "external" };
}

export function rewriteLoopbackOrigin(input: {
  readonly url: URL;
  readonly localPort: number;
}): URL {
  if (!Number.isInteger(input.localPort) || input.localPort < 1 || input.localPort > 65_535)
    throw new Error("Local port must be between 1 and 65535.");
  const rewritten = normalizeLoopbackDisplayUrl(input.url);
  if (!isHttpUrl(rewritten) || !isLoopbackHostname(rewritten.hostname))
    throw new Error("Only HTTP(S) loopback URLs can be rewritten.");
  rewritten.hostname = "127.0.0.1";
  rewritten.port = String(input.localPort);
  return rewritten;
}

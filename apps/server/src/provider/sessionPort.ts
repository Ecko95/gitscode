const SESSION_PORT_BASE = 30_000;
const SESSION_PORT_SPAN = 10_000;

export function sessionPortForSessionId(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // ponytail: deterministic hash only; replace with a real allocator if active
  // sessions ever collide in the 30000-39999 dev-server range.
  return SESSION_PORT_BASE + ((hash >>> 0) % SESSION_PORT_SPAN);
}

export function sessionPortEnv(sessionId: string): Record<string, string> {
  return { GITS_PORT: String(sessionPortForSessionId(sessionId)) };
}

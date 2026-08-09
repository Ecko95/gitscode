export function notificationTargetUrl(value: unknown, origin: string): string {
  const target = new URL(typeof value === "string" ? value : "/", origin);
  return target.origin === origin ? target.toString() : new URL("/", origin).toString();
}

// @effect-diagnostics nodeBuiltinImport:off - child environment discovery checks local browser executables.
import type { ThreadId } from "@t3tools/contracts";
import { existsSync } from "node:fs";

export const BROWSER_PREVIEW_AGENT_GUIDANCE = `When a task involves a browser or local web app, use the gsd-browser MCP tools so all interactions appear in this chat's Browser supervision panel. If starting a dev server, keep it running, read its actual listening URL, verify that URL is reachable, and navigate gsd-browser to it. Never guess a localhost port.`;

export function browser_preview_session_name(thread_id: ThreadId): string {
  return `gits-${String(thread_id)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80)}`;
}

export function browser_preview_mcp_args(thread_id: ThreadId): readonly string[] {
  return ["--session", browser_preview_session_name(thread_id), "mcp"];
}

export function browser_preview_mcp_env(): Readonly<Record<string, string>> {
  const candidates = [
    process.env.GSD_BROWSER_BROWSER_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    `${process.env.HOME ?? ""}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
    `${process.env.HOME ?? ""}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`,
  ];
  const browser_path = candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
  return {
    GSD_BROWSER_BROWSER_HEADLESS:
      process.env.GSD_BROWSER_BROWSER_HEADLESS ?? (process.env.DISPLAY ? "false" : "true"),
    ...(browser_path ? { GSD_BROWSER_BROWSER_PATH: browser_path } : {}),
  };
}

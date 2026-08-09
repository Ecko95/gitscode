// @effect-diagnostics nodeBuiltinImport:off globalDate:off - external CLI boundary and expiring viewer tickets.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
  BrowserPreviewAction,
  BrowserPreviewLifecycleStatus,
  BrowserPreviewStatus,
  ThreadId,
} from "@t3tools/contracts";
import { isLoopbackHostname } from "@t3tools/shared/environmentUrl";
import { sessionPortForSessionId } from "../provider/sessionPort.ts";

const exec_file = promisify(execFile);
const TICKET_TTL_MS = 2 * 60 * 1000;
const SESSION_PREFIX = "gits-";
const CONTROL_COMMANDS: Record<
  Exclude<BrowserPreviewAction, "navigate" | "instruct" | "console">,
  string
> = {
  pause: "pause",
  resume: "resume",
  step: "step",
  abort: "abort",
  takeover: "takeover",
  release: "release-control",
};

interface BrowserPreviewSession {
  readonly thread_id: ThreadId;
  readonly session_name: string;
  viewer_url: URL | null;
  preview_ticket: string | null;
  preview_ticket_expires_at_ms: number | null;
  status: BrowserPreviewLifecycleStatus;
  message: string | null;
  console_entries: string[];
}

interface BrowserPreviewTicket {
  readonly thread_id: ThreadId;
  readonly viewer_url: URL;
  readonly expires_at_ms: number;
}

type BrowserPreviewRun = (
  sessionName: string,
  command: string,
  commandArgs?: readonly string[],
) => Promise<Record<string, unknown>>;

export interface BrowserPreviewManagerOptions {
  readonly run?: BrowserPreviewRun;
}

// Playwright installs each Chromium build under its own `chromium-<revision>` directory and
// prunes old ones, so pinning revisions goes stale on the next `playwright install`.
const PLAYWRIGHT_CHROME_RELATIVE_PATHS = [
  "chrome-linux64/chrome",
  "chrome-linux/chrome",
  "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
] as const;

export function playwright_chrome_candidates(cache_dir: string): ReadonlyArray<string> {
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(cache_dir);
  } catch {
    return [];
  }

  return (
    entries
      .flatMap((entry) => {
        const revision = /^chromium(?:_headless_shell)?-(\d+)$/u.exec(entry)?.[1];
        return revision === undefined ? [] : [{ entry, revision: Number(revision) }];
      })
      // Newest revision first: Playwright keeps older builds around until they are pruned.
      .sort((left, right) => right.revision - left.revision)
      .flatMap(({ entry }) =>
        PLAYWRIGHT_CHROME_RELATIVE_PATHS.map((relative) => join(cache_dir, entry, relative)),
      )
  );
}

function resolve_browser_path(): string | undefined {
  if (process.env.GSD_BROWSER_BROWSER_PATH) {
    return process.env.GSD_BROWSER_BROWSER_PATH;
  }

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    ...(process.env.HOME
      ? playwright_chrome_candidates(join(process.env.HOME, ".cache", "ms-playwright"))
      : []),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function session_name_for_thread(thread_id: ThreadId): string {
  const safe_id = String(thread_id)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80);
  return `${SESSION_PREFIX}${safe_id}`;
}

function parse_json_output(output: string): Record<string, unknown> {
  const start = output.indexOf("{");
  if (start < 0) {
    throw new Error("gsd-browser returned no JSON response.");
  }
  return JSON.parse(output.slice(start)) as Record<string, unknown>;
}

export class BrowserPreviewManager {
  readonly #sessions = new Map<ThreadId, BrowserPreviewSession>();
  readonly #tickets = new Map<string, BrowserPreviewTicket>();
  readonly #runOverride: BrowserPreviewRun | undefined;

  constructor(options: BrowserPreviewManagerOptions = {}) {
    this.#runOverride = options.run;
  }

  async #run(
    session_name: string,
    command: string,
    command_args: readonly string[] = [],
  ): Promise<Record<string, unknown>> {
    if (this.#runOverride) return this.#runOverride(session_name, command, command_args);
    const browser_path = resolve_browser_path();
    const args = ["--session", session_name];
    if (browser_path) {
      args.push("--browser-path", browser_path);
    }
    args.push(command, ...command_args, "--json");

    const { stdout, stderr } = await exec_file("gsd-browser", args, {
      env: {
        ...process.env,
        GSD_BROWSER_BROWSER_HEADLESS:
          process.env.GSD_BROWSER_BROWSER_HEADLESS ?? (process.env.DISPLAY ? "false" : "true"),
      },
      maxBuffer: 2 * 1024 * 1024,
    });
    return parse_json_output(`${stderr}\n${stdout}`);
  }

  async open(thread_id: ThreadId): Promise<BrowserPreviewStatus> {
    const session = this.#sessions.get(thread_id) ?? {
      thread_id,
      session_name: session_name_for_thread(thread_id),
      viewer_url: null,
      preview_ticket: null,
      preview_ticket_expires_at_ms: null,
      status: "starting" as const,
      message: null,
      console_entries: [],
    };
    this.#sessions.set(thread_id, session);
    session.status = "starting";

    try {
      let result: Record<string, unknown>;
      try {
        result = await this.#run(session.session_name, "view", ["--print-only"]);
      } catch {
        // A cold Chromium launch can narrowly exceed gsd-browser's 10s startup wait
        // while leaving a healthy daemon behind. One idempotent retry recovers it.
        result = await this.#run(session.session_name, "view", ["--print-only"]);
      }
      if (typeof result.url !== "string") {
        throw new Error(
          typeof result.error === "object"
            ? JSON.stringify(result.error)
            : "Viewer URL was not returned.",
        );
      }
      const viewer_url = new URL(result.url);
      if (
        (viewer_url.protocol !== "http:" && viewer_url.protocol !== "https:") ||
        !isLoopbackHostname(viewer_url.hostname)
      ) {
        throw new Error("Browser viewer URL must use HTTP(S) loopback.");
      }
      this.revokeThread(thread_id);
      session.viewer_url = viewer_url;
      session.status = "live";
      session.message = null;
      return this.#issue_status(session);
    } catch (cause) {
      session.status = "error";
      session.message = cause instanceof Error ? cause.message : String(cause);
      return this.#to_status(session);
    }
  }

  async status(thread_id: ThreadId): Promise<BrowserPreviewStatus> {
    const session = this.#sessions.get(thread_id);
    if (!session) {
      return {
        available: true,
        status: "idle",
        previewPath: null,
        terminalUrl: `http://localhost:${sessionPortForSessionId(thread_id)}`,
        consoleEntries: [],
        expiresAt: null,
        message: null,
      };
    }

    try {
      const state = await this.#run(session.session_name, "control-state");
      session.status = this.#map_control_status(state);
      session.message = null;
    } catch (cause) {
      session.status = "unavailable";
      session.message = cause instanceof Error ? cause.message : String(cause);
    }
    return session.viewer_url ? this.#issue_status(session) : this.#to_status(session);
  }

  async control(
    thread_id: ThreadId,
    action: BrowserPreviewAction,
    requested_url?: string,
    instruction?: string,
  ): Promise<BrowserPreviewStatus> {
    const session = this.#sessions.get(thread_id);
    if (!session) {
      throw new Error("Open the browser preview before sending controls.");
    }
    if (action === "navigate") {
      const url = new URL(requested_url ?? "");
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Browser URLs must use http or https.");
      }
      await this.#run(session.session_name, "navigate", [url.toString()]);
    } else if (action === "instruct") {
      const browser_instruction = instruction?.trim();
      if (!browser_instruction) {
        throw new Error("A browser instruction is required.");
      }
      await this.#run(session.session_name, "act-instruction", [browser_instruction]);
    } else if (action === "console") {
      const result = await this.#run(session.session_name, "console");
      session.console_entries = Array.isArray(result.entries)
        ? result.entries.map((entry) => JSON.stringify(entry))
        : [];
    } else {
      await this.#run(session.session_name, CONTROL_COMMANDS[action]);
    }
    return this.status(thread_id);
  }

  resolve_ticket(ticket: string): BrowserPreviewTicket | null {
    const entry = this.#tickets.get(ticket);
    if (!entry || entry.expires_at_ms <= Date.now()) {
      this.#tickets.delete(ticket);
      return null;
    }
    return entry;
  }

  async stop(thread_id: ThreadId): Promise<void> {
    const session = this.#sessions.get(thread_id);
    this.revokeThread(thread_id);
    if (!session) return;
    this.#sessions.delete(thread_id);
    await this.#run(session.session_name, "daemon", ["stop"]).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((thread_id) => this.stop(thread_id)));
    this.revokeAll();
  }

  revokeThread(thread_id: ThreadId): void {
    for (const [ticket, entry] of this.#tickets) {
      if (entry.thread_id === thread_id) this.#tickets.delete(ticket);
    }
    const session = this.#sessions.get(thread_id);
    if (session) {
      session.preview_ticket = null;
      session.preview_ticket_expires_at_ms = null;
    }
  }

  revokeAll(): void {
    this.#tickets.clear();
    for (const session of this.#sessions.values()) {
      session.preview_ticket = null;
      session.preview_ticket_expires_at_ms = null;
    }
  }

  #issue_status(session: BrowserPreviewSession): BrowserPreviewStatus {
    if (!session.viewer_url) return this.#to_status(session);
    const can_reuse_ticket =
      session.preview_ticket !== null &&
      session.preview_ticket_expires_at_ms !== null &&
      session.preview_ticket_expires_at_ms > Date.now() + 30_000;
    const ticket = can_reuse_ticket ? session.preview_ticket! : randomUUID();
    const expires_at_ms = can_reuse_ticket
      ? session.preview_ticket_expires_at_ms!
      : Date.now() + TICKET_TTL_MS;
    if (!can_reuse_ticket) {
      if (session.preview_ticket) this.#tickets.delete(session.preview_ticket);
      session.preview_ticket = ticket;
      session.preview_ticket_expires_at_ms = expires_at_ms;
      this.#tickets.set(ticket, {
        thread_id: session.thread_id,
        viewer_url: session.viewer_url,
        expires_at_ms,
      });
    }
    const preview_params = new URLSearchParams({ ticket });
    return {
      available: true,
      status: session.status,
      previewPath: `/api/browser-preview/view?${preview_params.toString()}`,
      terminalUrl: `http://localhost:${sessionPortForSessionId(session.thread_id)}`,
      consoleEntries: session.console_entries,
      expiresAt: new Date(expires_at_ms).toISOString(),
      message: session.message,
    };
  }

  #to_status(session: BrowserPreviewSession): BrowserPreviewStatus {
    return {
      available: true,
      status: session.status,
      previewPath: null,
      terminalUrl: `http://localhost:${sessionPortForSessionId(session.thread_id)}`,
      consoleEntries: session.console_entries,
      expiresAt: null,
      message: session.message,
    };
  }

  #map_control_status(state: Record<string, unknown>): BrowserPreviewLifecycleStatus {
    if (state.owner === "viewer") return "takeover";
    if (state.mode === "agent-paused" || state.mode === "paused") return "paused";
    return "live";
  }
}

export const browser_preview_manager = new BrowserPreviewManager();

// @effect-diagnostics nodeBuiltinImport:off globalDate:off - external CLI boundary and expiring viewer tickets.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import type {
  BrowserPreviewAction,
  BrowserPreviewLifecycleStatus,
  BrowserPreviewStatus,
  ThreadId,
} from "@t3tools/contracts";
import { sessionPortForSessionId } from "../provider/sessionPort.ts";

const exec_file = promisify(execFile);
const TICKET_TTL_MS = 2 * 60 * 1000;
const SESSION_PREFIX = "gits-";
const CONTROL_COMMANDS: Record<Exclude<BrowserPreviewAction, "navigate" | "instruct">, string> = {
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
}

interface BrowserPreviewTicket {
  readonly thread_id: ThreadId;
  readonly viewer_url: URL;
  readonly expires_at_ms: number;
}

function resolve_browser_path(): string | undefined {
  if (process.env.GSD_BROWSER_BROWSER_PATH) {
    return process.env.GSD_BROWSER_BROWSER_PATH;
  }

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    `${process.env.HOME ?? ""}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
    `${process.env.HOME ?? ""}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`,
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

  async #run(
    session_name: string,
    command: string,
    command_args: readonly string[] = [],
  ): Promise<Record<string, unknown>> {
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
      session.viewer_url = new URL(result.url);
      session.preview_ticket = null;
      session.preview_ticket_expires_at_ms = null;
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
    if (!session) return;
    this.#sessions.delete(thread_id);
    await this.#run(session.session_name, "daemon", ["stop"]).catch(() => undefined);
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
      session.preview_ticket = ticket;
      session.preview_ticket_expires_at_ms = expires_at_ms;
      this.#tickets.set(ticket, {
        thread_id: session.thread_id,
        viewer_url: session.viewer_url,
        expires_at_ms,
      });
    }
    const preview_params = new URLSearchParams(session.viewer_url.searchParams);
    preview_params.set("ticket", ticket);
    return {
      available: true,
      status: session.status,
      previewPath: `/api/browser-preview/view?${preview_params.toString()}`,
      terminalUrl: `http://localhost:${sessionPortForSessionId(session.thread_id)}`,
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

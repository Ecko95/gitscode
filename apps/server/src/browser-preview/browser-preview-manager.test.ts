import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { BrowserPreviewManager, playwright_chrome_candidates } from "./browser-preview-manager.ts";

const threadId = ThreadId.make("thread-browser-preview");

describe("BrowserPreviewManager", () => {
  it("rejects non-loopback viewer URLs", async () => {
    const manager = new BrowserPreviewManager({
      run: async () => ({ url: "https://viewer.example.test/" }),
    });

    await expect(manager.open(threadId)).resolves.toMatchObject({
      status: "error",
      previewPath: null,
      message: expect.stringMatching(/loopback/i),
    });
  });

  it("navigates only to the URL selected by the caller", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const manager = new BrowserPreviewManager({
      run: async (_session, command, args = []) => {
        calls.push({ command, args });
        if (command === "view") return { url: "http://127.0.0.1:9222/" };
        if (command === "control-state") return { mode: "agent" };
        return {};
      },
    });

    await manager.open(threadId);
    await manager.control(threadId, "navigate", "http://127.0.0.1:5173/path?q=1#selected");

    expect(calls.filter(({ command }) => command === "navigate")).toEqual([
      {
        command: "navigate",
        args: ["http://127.0.0.1:5173/path?q=1#selected"],
      },
    ]);
  });

  it("revokes a thread ticket before stopping its daemon", async () => {
    const manager = new BrowserPreviewManager({
      run: async (_session, command) =>
        command === "view" ? { url: "http://127.0.0.1:9222/?viewer-secret=hidden" } : {},
    });
    const opened = await manager.open(threadId);
    expect(opened.previewPath).not.toContain("viewer-secret");
    const ticket = new URL(opened.previewPath!, "http://gits.test").searchParams.get("ticket")!;

    expect(manager.resolve_ticket(ticket)).not.toBeNull();
    await manager.stop(threadId);
    expect(manager.resolve_ticket(ticket)).toBeNull();
  });

  it("stops every browser session during shutdown", async () => {
    const stopped: string[] = [];
    const manager = new BrowserPreviewManager({
      run: async (session, command, args) => {
        if (command === "view") return { url: "http://127.0.0.1:9222/" };
        if (command === "daemon" && args?.[0] === "stop") stopped.push(session);
        return {};
      },
    });
    const first = await manager.open(ThreadId.make("thread-one"));
    const second = await manager.open(ThreadId.make("thread-two"));
    const tickets = [first, second].map(
      (opened) => new URL(opened.previewPath!, "http://gits.test").searchParams.get("ticket")!,
    );

    await manager.stopAll();

    expect(stopped).toHaveLength(2);
    expect(tickets.map((ticket) => manager.resolve_ticket(ticket))).toEqual([null, null]);
  });
});

describe("playwright_chrome_candidates", () => {
  it("prefers the newest revision and ignores unrelated cache entries", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "gits-playwright-cache-"));
    try {
      for (const entry of ["chromium-1208", "chromium-1228", "firefox-1489", ".links"]) {
        await fs.mkdir(path.join(cacheDir, entry), { recursive: true });
      }

      const candidates = playwright_chrome_candidates(cacheDir);

      expect(candidates[0]).toBe(path.join(cacheDir, "chromium-1228", "chrome-linux64", "chrome"));
      expect(candidates).toContain(
        path.join(cacheDir, "chromium-1208", "chrome-linux64", "chrome"),
      );
      expect(candidates.join(" ")).not.toContain("firefox");
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("returns nothing when the cache directory is absent", () => {
    expect(playwright_chrome_candidates("/nonexistent/ms-playwright")).toEqual([]);
  });
});

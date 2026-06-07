// @effect-diagnostics nodeBuiltinImport:off
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { build_turn_start_command, parse_crit_payload, run_crit_agent } from "./crit-agent-cli.ts";

describe("parse_crit_payload", () => {
  it("normalizes crit's JSON stdin into a comment record", () => {
    const raw = JSON.stringify({
      comment: "use a guard clause",
      quoted: "if (x) { ... }",
      filePath: "src/app.ts",
      startLine: 10,
      endLine: 12,
    });
    const parsed = parse_crit_payload(raw);
    expect(parsed.text).toBe("use a guard clause");
    expect(parsed.filePath).toBe("src/app.ts");
    expect(parsed.startIndex).toBe(10);
    expect(parsed.endIndex).toBe(12);
    expect(parsed.diff).toContain("if (x)");
  });

  it("falls back to treating raw stdin as the comment text", () => {
    const parsed = parse_crit_payload("just a plain comment");
    expect(parsed.text).toBe("just a plain comment");
    expect(parsed.filePath).toBe("");
  });
});

describe("build_turn_start_command", () => {
  it("builds a valid thread.turn.start command with a review-comment body", () => {
    const cmd = build_turn_start_command("thread-123", {
      text: "fix this",
      filePath: "a.ts",
      startIndex: 1,
      endIndex: 2,
      diff: "-a\n+b",
    });
    expect(cmd.type).toBe("thread.turn.start");
    expect(cmd.threadId).toBe("thread-123");
    expect(cmd.message.role).toBe("user");
    expect(cmd.message.text).toContain("<review_comment");
    expect(cmd.message.text).toContain("fix this");
    expect(cmd.runtimeMode).toBe("full-access");
    expect(cmd.interactionMode).toBe("default");
    expect(typeof cmd.commandId).toBe("string");
    expect(typeof cmd.message.messageId).toBe("string");
    expect(cmd.message.attachments).toEqual([]);
  });
});

function start_mock_gits(
  handler: (url: string, method: string) => unknown,
): Promise<{ origin: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const body = handler(req.url ?? "", req.method ?? "GET");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body ?? {}));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, server });
    });
  });
}

describe("run_crit_agent", () => {
  let mock: { origin: string; server: Server };
  afterEach(() => mock?.server.close());

  it("dispatches the turn and returns the assistant reply text", async () => {
    let dispatched = false;
    mock = await start_mock_gits((url, method) => {
      if (url.endsWith("/api/orchestration/dispatch") && method === "POST") {
        dispatched = true;
        return {};
      }
      if (url.endsWith("/api/orchestration/snapshot")) {
        return {
          projects: [],
          threads: [
            {
              id: "thread-123",
              latestTurn: { state: "completed", assistantMessageId: "msg-9" },
              messages: [
                { id: "msg-9", role: "assistant", text: "Done — applied the guard clause." },
              ],
            },
          ],
        };
      }
      return {};
    });
    const reply = await run_crit_agent({
      origin: mock.origin,
      token: "t",
      threadId: "thread-123",
      timeoutMs: 2000,
      pollMs: 50,
      stdin: JSON.stringify({ comment: "fix", filePath: "a.ts", startLine: 1, endLine: 1 }),
    });
    expect(dispatched).toBe(true);
    expect(reply).toBe("Done — applied the guard clause.");
  });

  it("returns an ack when the turn does not complete before timeout", async () => {
    mock = await start_mock_gits((url) => {
      if (url.endsWith("/api/orchestration/snapshot"))
        return {
          projects: [],
          threads: [
            {
              id: "thread-123",
              latestTurn: { state: "running", assistantMessageId: null },
              messages: [],
            },
          ],
        };
      return {};
    });
    const reply = await run_crit_agent({
      origin: mock.origin,
      token: "t",
      threadId: "thread-123",
      timeoutMs: 300,
      pollMs: 50,
      stdin: JSON.stringify({ comment: "fix", filePath: "a.ts", startLine: 1, endLine: 1 }),
    });
    expect(reply).toContain("Sent to GITS");
  });
});

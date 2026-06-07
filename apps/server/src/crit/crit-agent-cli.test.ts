// @effect-diagnostics nodeBuiltinImport:off
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { build_review_text, parse_crit_payload, run_crit_agent } from "./crit-agent-cli.ts";

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

describe("build_review_text", () => {
  it("builds a review-comment block from a normalized comment", () => {
    const text = build_review_text({
      text: "fix this",
      filePath: "a.ts",
      startIndex: 1,
      endIndex: 2,
      diff: "-a\n+b",
    });
    expect(text).toContain("<review_comment");
    expect(text).toContain('filePath="a.ts"');
    expect(text).toContain("fix this");
    expect(text).toContain("```diff");
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

  it("starts the turn and returns the completed turn's reply", async () => {
    let started = false;
    mock = await start_mock_gits((url, method) => {
      if (url.startsWith("/api/crit/turn-status")) {
        return {
          state: "completed",
          assistantMessageId: "msg-9",
          reply: "Done — applied the guard clause.",
        };
      }
      if (url.endsWith("/api/crit/turn") && method === "POST") {
        started = true;
        return { priorTurnId: null };
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
    expect(started).toBe(true);
    expect(reply).toBe("Done — applied the guard clause.");
  });

  it("handles a pending → completed transition", async () => {
    let statusPolls = 0;
    mock = await start_mock_gits((url, method) => {
      if (url.startsWith("/api/crit/turn-status")) {
        statusPolls += 1;
        if (statusPolls <= 1) {
          return { state: "pending", assistantMessageId: null, reply: null };
        }
        return { state: "completed", assistantMessageId: "msg-9", reply: "NEW REPLY" };
      }
      if (url.endsWith("/api/crit/turn") && method === "POST") {
        return { priorTurnId: "turn-1" };
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
    expect(statusPolls).toBeGreaterThan(1);
    expect(reply).toBe("NEW REPLY");
  });

  it("returns an ack when the turn does not complete before timeout", async () => {
    mock = await start_mock_gits((url, method) => {
      if (url.startsWith("/api/crit/turn-status")) {
        return { state: "pending", assistantMessageId: null, reply: null };
      }
      if (url.endsWith("/api/crit/turn") && method === "POST") {
        return { priorTurnId: null };
      }
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

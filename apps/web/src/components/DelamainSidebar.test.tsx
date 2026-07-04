import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentId } from "@t3tools/contracts";

// The web vitest suite runs under the `node` environment (no jsdom).
// We render with renderToStaticMarkup matching the other component tests.
vi.mock("~/gitsClient", () => ({ readGitsEnvironmentClient: vi.fn(() => null) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: null, isPending: false, isError: false })),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

// --- Transcript parser (copy of module-private functions, tested standalone) ---

type LogEntryType =
  | "system"
  | "user"
  | "assistant"
  | "tool_call"
  | "error"
  | "turn.failed"
  | string;

interface ParsedLogEntry {
  type: LogEntryType;
  text: string | null;
  tool: string | null;
  raw: string;
}

function parse_log_line(raw: string): ParsedLogEntry {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const type = (obj["type"] as LogEntryType) ?? "unknown";
    const text: string | null =
      typeof obj["content"] === "string"
        ? obj["content"]
        : typeof obj["message"] === "string"
          ? obj["message"]
          : typeof obj["text"] === "string"
            ? obj["text"]
            : typeof obj["summary"] === "string"
              ? obj["summary"]
              : null;
    const tool: string | null = typeof obj["name"] === "string" ? obj["name"] : null;
    return { type, text, tool, raw };
  } catch {
    return { type: "unknown", text: raw.trim() || null, tool: null, raw };
  }
}

function parse_log_text(text: string): ParsedLogEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map(parse_log_line);
}

// --- Tests: transcript parser ---

describe("parse_log_line", () => {
  it("parses a valid assistant entry", () => {
    const raw = JSON.stringify({ type: "assistant", content: "Hello world" });
    const entry = parse_log_line(raw);
    expect(entry.type).toBe("assistant");
    expect(entry.text).toBe("Hello world");
  });

  it("parses a tool_call entry with name field", () => {
    const raw = JSON.stringify({ type: "tool_call", name: "bash", content: "ls -la" });
    const entry = parse_log_line(raw);
    expect(entry.type).toBe("tool_call");
    expect(entry.tool).toBe("bash");
    expect(entry.text).toBe("ls -la");
  });

  it("parses an error entry", () => {
    const raw = JSON.stringify({ type: "error", message: "Connection refused" });
    const entry = parse_log_line(raw);
    expect(entry.type).toBe("error");
    expect(entry.text).toBe("Connection refused");
  });

  it("falls back gracefully on malformed JSON", () => {
    const raw = "not json at all {{";
    const entry = parse_log_line(raw);
    expect(entry.type).toBe("unknown");
    expect(entry.raw).toBe(raw);
    // text is the trimmed raw for display
    expect(entry.text).toBe(raw);
  });

  it("handles empty lines gracefully (filter prevents them, but guard anyway)", () => {
    const entry = parse_log_line("{}");
    expect(entry.type).toBe("unknown");
    expect(entry.text).toBeNull();
  });
});

describe("parse_log_text", () => {
  it("splits multi-line JSONL and parses each entry", () => {
    const text = [
      JSON.stringify({ type: "system", content: "Session started" }),
      JSON.stringify({ type: "user", content: "Do the thing" }),
      JSON.stringify({ type: "assistant", content: "Sure" }),
    ].join("\n");

    const entries = parse_log_text(text);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.type).toBe("system");
    expect(entries[1]!.type).toBe("user");
    expect(entries[2]!.type).toBe("assistant");
  });

  it("skips blank lines", () => {
    const text = "\n\n" + JSON.stringify({ type: "assistant", content: "Hi" }) + "\n\n";
    const entries = parse_log_text(text);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for empty text", () => {
    expect(parse_log_text("")).toHaveLength(0);
    expect(parse_log_text("   \n  ")).toHaveLength(0);
  });

  it("mixes valid and malformed lines — malformed become raw fallback", () => {
    const text = [JSON.stringify({ type: "user", content: "Hi" }), "MALFORMED{{", ""].join("\n");
    const entries = parse_log_text(text);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe("user");
    expect(entries[1]!.type).toBe("unknown");
    expect(entries[1]!.text).toBe("MALFORMED{{");
  });
});

// --- Tests: DelamainSidebar rendering ---

import DelamainSidebar from "./DelamainSidebar";

describe("DelamainSidebar", () => {
  const env_id = "env-test" as EnvironmentId;

  it("renders the empty-state when no peers match", () => {
    const markup = renderToStaticMarkup(
      <DelamainSidebar
        environmentId={env_id}
        projectRepoRoot="/home/user/myrepo"
        onClose={() => undefined}
      />,
    );
    expect(markup).toContain("No deployed peers for this repo");
  });

  it("shows the Delamain badge", () => {
    const markup = renderToStaticMarkup(
      <DelamainSidebar
        environmentId={env_id}
        projectRepoRoot={undefined}
        onClose={() => undefined}
      />,
    );
    expect(markup).toContain("Delamain");
  });

  it("renders close button with accessible label", () => {
    const markup = renderToStaticMarkup(
      <DelamainSidebar environmentId={env_id} projectRepoRoot="/repo" onClose={() => undefined} />,
    );
    expect(markup).toContain("Close delamain sidebar");
  });
});

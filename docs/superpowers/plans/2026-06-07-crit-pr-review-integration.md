# Crit PR Review Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the [crit](https://github.com/tomasz-tomczyk/crit) review binary as a GITS-managed sidecar, render its UI in the PR view, and route "send to agent" into the active GITS thread so the user's default provider (codex) answers.

**Architecture:** `apps/server` spawns one bundled crit binary per workspace and sets crit's `agent_cmd` to a thin GITS wrapper CLI. The wrapper reads crit's comment payload on stdin, POSTs a `thread.turn.start` to the existing `/api/orchestration/dispatch` endpoint, blocks while polling `/api/orchestration/snapshot` until the turn completes, then prints the assistant reply on stdout for crit to thread. `apps/web` renders crit's local URL in an `<iframe>` panel that replaces the sidebar `DiffPanel` for PR review.

**Tech Stack:** TypeScript, Effect (server), React + TanStack Router (web), Electron 41 (desktop, electron-builder via `scripts/build-desktop-artifact.ts`), Vitest, Bun, Go binary (crit, bundled).

**Design spec:** `docs/superpowers/specs/2026-06-07-crit-pr-review-integration-design.md`

**Conventions (from `AGENTS.md` / global rules):** tabs, double quotes, semicolons, snake_case functions/vars, PascalCase types/components, kebab-case files. Gate every task on `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` (NEVER `bun test`). Commit after each task.

---

## File Structure

**Create:**

- `packages/shared/src/crit/review-comment-block.ts` — pure builder for the `<review_comment>` block (the exact format the existing web parser reads).
- `packages/shared/src/crit/review-comment-block.test.ts` — builder unit tests.
- `apps/server/src/crit/crit-agent-cli.ts` — the `agent_cmd` entrypoint crit invokes (standalone, `fetch`-based).
- `apps/server/src/crit/crit-agent-cli.test.ts` — wrapper tests against a mock GITS HTTP server.
- `apps/server/src/crit/crit-binary-resolver.ts` — resolve the bundled crit binary path per platform/arch with env + PATH fallback.
- `apps/server/src/crit/crit-binary-resolver.test.ts` — resolver tests.
- `apps/server/src/crit/crit-sidecar-manager.ts` — Effect service that spawns/lifecycles crit per workspace and exposes URL/status.
- `apps/server/src/crit/crit-sidecar-manager.test.ts` — sidecar lifecycle tests.
- `apps/web/src/components/CritReviewPanel.tsx` — iframe panel + status/fallback handling.
- `docs/crit-integration-notes.md` — captured discovery findings (crit CLI flags, stdin payload format, license).

**Modify:**

- `packages/shared/package.json` — add `./crit/*` subpath export if subpath exports are explicit.
- `apps/server/src/wsServer.ts` (and/or `apps/server/src/gits/http.ts`) — expose `crit.ensureSidecar` / `crit.sidecarStatus`.
- `apps/web/src/localApi.ts` — client methods for the crit sidecar.
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx:134` — render `CritReviewPanel` instead of `LazyDiffPanel mode="sidebar"` when crit review is enabled.
- `scripts/build-desktop-artifact.ts` — add crit binaries to electron-builder `extraResources`.

---

## Phase 0 — Discovery (gates everything; produces `docs/crit-integration-notes.md`)

These tasks resolve the three genuine unknowns about the upstream tool. Each records its finding in `docs/crit-integration-notes.md` so later tasks have exact values, not guesses.

### Task 0a: Confirm crit license permits redistribution

- [ ] **Step 1: Read the license**

Run:

```bash
PATH="$HOME/.local/bin:$PATH" rtk curl -s https://raw.githubusercontent.com/tomasz-tomczyk/crit/main/LICENSE | head -30
```

Expected: an OSI license (MIT/Apache-2.0). Record the SPDX id.

- [ ] **Step 2: Record finding and decide bundling**

Create `docs/crit-integration-notes.md` with a `## License` section stating the SPDX id and "redistribution: allowed/blocked". If blocked, STOP and escalate — the bundling approach (Phase 6) must switch to auto-download-on-first-use (deferred alt in the spec).

- [ ] **Step 3: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add docs/crit-integration-notes.md && rtk git commit -m "docs(crit): record crit license + redistribution decision"
```

### Task 0b: Capture crit's CLI flags for repo, bind host/port, and `agent_cmd`

- [ ] **Step 1: Build or fetch a crit binary for the dev platform**

Run (clone + build, Go required):

```bash
git clone https://github.com/tomasz-tomczyk/crit /tmp/crit-src && cd /tmp/crit-src && go build -o /tmp/crit . && /tmp/crit --help
```

Expected: usage text listing flags/subcommands.

- [ ] **Step 2: Identify the exact flags**

From `--help` (and `/tmp/crit <subcommand> --help`), record in `docs/crit-integration-notes.md` under `## CLI`:

- how to point crit at a repo root + branch/PR,
- how to set the bind host (must support `127.0.0.1`) and a chosen port,
- how to set `agent_cmd` non-interactively (config file path or flag),
- the startup line/health endpoint that signals "server ready" (URL + port).

- [ ] **Step 3: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add docs/crit-integration-notes.md && rtk git commit -m "docs(crit): record crit CLI flags for embedding"
```

### Task 0c: Capture crit's stdin payload format for `agent_cmd`

- [ ] **Step 1: Set agent_cmd to a capture script and trigger one comment**

Create `/tmp/crit-capture.sh`:

```bash
#!/usr/bin/env bash
cat > /tmp/crit-stdin-capture.txt
echo "captured"
```

Run `chmod +x /tmp/crit-capture.sh`, configure crit's `agent_cmd` to it (per Task 0b finding), open crit on a test repo, add a comment on a line range, and click send.

- [ ] **Step 2: Record the exact payload shape**

Run:

```bash
cat /tmp/crit-stdin-capture.txt
```

Record in `docs/crit-integration-notes.md` under `## agent_cmd stdin`: whether it is JSON or plain text, and the exact field names/order for comment text, quoted text, file path, and line range. **Phase 2 (wrapper) parsing must match this exactly.**

- [ ] **Step 3: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add docs/crit-integration-notes.md && rtk git commit -m "docs(crit): record agent_cmd stdin payload format"
```

---

## Phase 1 — Review-comment block builder (`packages/shared`)

The wrapper must emit the exact `<review_comment>` block that `apps/web/src/reviewCommentContext.ts` already parses (attributes: `startIndex`, `endIndex`, `filePath`, `sectionId`, `sectionTitle`, `rangeLabel`; body = comment text then a ` ```diff ` fence). The parser unescapes `&lt;`/`&quot;`/`&amp;`, so the builder must escape attribute values symmetrically.

### Task 1: Build the review-comment block

**Files:**

- Create: `packages/shared/src/crit/review-comment-block.ts`
- Test: `packages/shared/src/crit/review-comment-block.test.ts`

- [ ] **Step 1: Write the failing test**

````typescript
import { describe, expect, it } from "vitest";
import { build_review_comment_block } from "./review-comment-block.ts";

describe("build_review_comment_block", () => {
  it("emits attributes and a diff fence the web parser can read", () => {
    const block = build_review_comment_block({
      filePath: "src/app.ts",
      sectionId: "sec-1",
      sectionTitle: "Review",
      rangeLabel: "lines",
      startIndex: 10,
      endIndex: 12,
      text: 'Avoid the "any" cast here',
      diff: "@@ -10,3 +10,3 @@\n-old\n+new",
    });

    expect(block).toContain('startIndex="10"');
    expect(block).toContain('endIndex="12"');
    expect(block).toContain('filePath="src/app.ts"');
    expect(block).toContain('sectionId="sec-1"');
    expect(block).toContain("```diff");
    // attribute values are escaped symmetrically with the web unescaper
    expect(block).toContain("&quot;any&quot;");
    expect(block.startsWith("<review_comment")).toBe(true);
    expect(block.trimEnd().endsWith("</review_comment>")).toBe(true);
  });

  it("orders startIndex/endIndex low-to-high", () => {
    const block = build_review_comment_block({
      filePath: "a.ts",
      sectionId: "s",
      sectionTitle: "Review",
      rangeLabel: "line",
      startIndex: 9,
      endIndex: 4,
      text: "x",
      diff: "",
    });
    expect(block).toContain('startIndex="4"');
    expect(block).toContain('endIndex="9"');
  });
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run packages/shared/src/crit/review-comment-block.test.ts`
Expected: FAIL — `build_review_comment_block` is not defined.

- [ ] **Step 3: Write the implementation**

````typescript
export interface ReviewCommentBlockInput {
  readonly filePath: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly rangeLabel: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
  readonly diff: string;
}

function escape_attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function build_review_comment_block(input: ReviewCommentBlockInput): string {
  const start = Math.min(input.startIndex, input.endIndex);
  const end = Math.max(input.startIndex, input.endIndex);
  const attributes = [
    `startIndex="${start}"`,
    `endIndex="${end}"`,
    `filePath="${escape_attribute(input.filePath)}"`,
    `sectionId="${escape_attribute(input.sectionId)}"`,
    `sectionTitle="${escape_attribute(input.sectionTitle)}"`,
    `rangeLabel="${escape_attribute(input.rangeLabel)}"`,
  ].join(" ");

  const body_parts = [input.text.trim()];
  const diff = input.diff.trim();
  if (diff.length > 0) {
    body_parts.push(["```diff", diff, "```"].join("\n"));
  }

  return `<review_comment ${attributes}>\n${body_parts.join("\n\n")}\n</review_comment>`;
}
````

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run packages/shared/src/crit/review-comment-block.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Verify the web parser round-trips the block**

Add this case to the test file (imports the existing parser to prevent format drift):

```typescript
import { parseReviewCommentMessageSegments } from "../../../../apps/web/src/reviewCommentContext.ts";

it("round-trips through the existing web parser", () => {
  const block = build_review_comment_block({
    filePath: "src/app.ts",
    sectionId: "sec-1",
    sectionTitle: "Review",
    rangeLabel: "lines",
    startIndex: 10,
    endIndex: 12,
    text: "comment body",
    diff: "@@ -10,1 +10,1 @@\n-a\n+b",
  });
  const segments = parseReviewCommentMessageSegments(block);
  const comment = segments.find((s) => s.kind === "review-comment");
  expect(comment).toBeDefined();
});
```

If the cross-app import is disallowed by lint/tsconfig boundaries, instead copy the three parser regexes from `reviewCommentContext.ts` into the test and assert a match. Re-run the test: Expected PASS.

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add packages/shared/src/crit && rtk git commit -m "feat(crit): add review-comment block builder in shared"
```

---

## Phase 2 — Wrapper CLI (`apps/server/src/crit/crit-agent-cli.ts`)

A standalone Node entrypoint (the `agent_cmd`). Dependency-light, uses global `fetch`, reads config from env set by the sidecar manager:

- `GITS_ORIGIN` (e.g. `http://127.0.0.1:4310`)
- `GITS_TOKEN` (scoped bearer token)
- `GITS_THREAD_ID` (the active thread the PR view is bound to)
- `GITS_TURN_TIMEOUT_MS` (optional, default `120000`)

Command payload confirmed against `packages/contracts/src/orchestration.ts` (`thread.turn.start`): ids are plain non-empty strings (`crypto.randomUUID()` is valid), `runtimeMode: "full-access"`, `interactionMode: "default"`, `createdAt` = ISO string. Snapshot is `{ projects, threads }`; a thread carries `latestTurn: { state: "running"|"interrupted"|"completed"|"error", assistantMessageId } | null` and `messages: { id, role, text }[]`.

### Task 2a: Parse crit's stdin payload into a normalized comment

**Files:**

- Create: `apps/server/src/crit/crit-agent-cli.ts`
- Test: `apps/server/src/crit/crit-agent-cli.test.ts`

> Adjust the parser in Step 3 to match the **exact** format recorded in Task 0c. The code below assumes crit pipes JSON `{ comment, quoted, filePath, startLine, endLine }`; if Task 0c found plain text, replace `parse_crit_payload` accordingly.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { parse_crit_payload } from "./crit-agent-cli.ts";

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-agent-cli.test.ts`
Expected: FAIL — `parse_crit_payload` is not defined.

- [ ] **Step 3: Write the parser (and the module's typed surface)**

```typescript
export interface NormalizedComment {
  readonly text: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly diff: string;
}

// Shape per docs/crit-integration-notes.md "agent_cmd stdin" (Task 0c).
interface CritStdinPayload {
  readonly comment?: string;
  readonly quoted?: string;
  readonly filePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

export function parse_crit_payload(raw: string): NormalizedComment {
  let payload: CritStdinPayload;
  try {
    payload = JSON.parse(raw) as CritStdinPayload;
  } catch {
    // Fallback: treat the whole stdin as the comment text.
    payload = { comment: raw };
  }

  const start = payload.startLine ?? 0;
  const end = payload.endLine ?? start;
  const quoted = (payload.quoted ?? "").trim();

  return {
    text: (payload.comment ?? "").trim(),
    filePath: (payload.filePath ?? "").trim(),
    startIndex: start,
    endIndex: end,
    diff: quoted.length > 0 ? quoted : "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-agent-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/crit && rtk git commit -m "feat(crit): parse crit agent_cmd stdin payload"
```

### Task 2b: Build the dispatch command and dispatch it

**Files:**

- Modify: `apps/server/src/crit/crit-agent-cli.ts`
- Test: `apps/server/src/crit/crit-agent-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { build_turn_start_command } from "./crit-agent-cli.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-agent-cli.test.ts`
Expected: FAIL — `build_turn_start_command` is not defined.

- [ ] **Step 3: Implement the command builder**

```typescript
import { randomUUID } from "node:crypto";
import { build_review_comment_block } from "@t3tools/shared/crit/review-comment-block";

export interface ThreadTurnStartCommandBody {
  readonly type: "thread.turn.start";
  readonly commandId: string;
  readonly threadId: string;
  readonly message: {
    readonly messageId: string;
    readonly role: "user";
    readonly text: string;
    readonly attachments: readonly never[];
  };
  readonly runtimeMode: "full-access";
  readonly interactionMode: "default";
  readonly createdAt: string;
}

export function build_turn_start_command(
  threadId: string,
  comment: NormalizedComment,
): ThreadTurnStartCommandBody {
  const text = build_review_comment_block({
    filePath: comment.filePath,
    sectionId: `crit:${comment.filePath}:${comment.startIndex}-${comment.endIndex}`,
    sectionTitle: "Crit review",
    rangeLabel: comment.startIndex === comment.endIndex ? "line" : "lines",
    startIndex: comment.startIndex,
    endIndex: comment.endIndex,
    text: comment.text,
    diff: comment.diff,
  });

  return {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  };
}
```

> If `@t3tools/shared/crit/review-comment-block` does not resolve, confirm `packages/shared/package.json` exposes the subpath (see Task 5 of this phase) — `packages/shared` uses explicit subpath exports per `AGENTS.md`.

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-agent-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/crit packages/shared && rtk git commit -m "feat(crit): build thread.turn.start command from crit comment"
```

### Task 2c: Block-and-return — poll the snapshot until the turn completes

**Files:**

- Modify: `apps/server/src/crit/crit-agent-cli.ts`
- Test: `apps/server/src/crit/crit-agent-cli.test.ts`

- [ ] **Step 1: Write the failing test (against a mock GITS HTTP server)**

```typescript
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run_crit_agent } from "./crit-agent-cli.ts";

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
      stdin: JSON.stringify({ comment: "fix", filePath: "a.ts", startLine: 1, endLine: 1 }),
    });

    expect(dispatched).toBe(true);
    expect(reply).toBe("Done — applied the guard clause.");
  });

  it("returns an ack when the turn does not complete before timeout", async () => {
    mock = await start_mock_gits((url) => {
      if (url.endsWith("/api/orchestration/snapshot")) {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-agent-cli.test.ts`
Expected: FAIL — `run_crit_agent` is not defined.

- [ ] **Step 3: Implement dispatch + poll + main**

```typescript
interface SnapshotThread {
  readonly id: string;
  readonly latestTurn: {
    readonly state: string;
    readonly assistantMessageId: string | null;
  } | null;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }>;
}
interface Snapshot {
  readonly threads: ReadonlyArray<SnapshotThread>;
}

export interface RunCritAgentOptions {
  readonly origin: string;
  readonly token: string;
  readonly threadId: string;
  readonly stdin: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function dispatch_command(
  options: RunCritAgentOptions,
  command: ThreadTurnStartCommandBody,
): Promise<void> {
  const response = await fetch(`${options.origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error(`GITS dispatch failed (${response.status}): ${await response.text()}`);
  }
}

async function read_snapshot(options: RunCritAgentOptions): Promise<Snapshot> {
  const response = await fetch(`${options.origin}/api/orchestration/snapshot`, {
    headers: { accept: "application/json", authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) {
    throw new Error(`GITS snapshot failed (${response.status})`);
  }
  return (await response.json()) as Snapshot;
}

export async function run_crit_agent(options: RunCritAgentOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const comment = parse_crit_payload(options.stdin);
  const command = build_turn_start_command(options.threadId, comment);

  await dispatch_command(options, command);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const snapshot = await read_snapshot(options);
    const thread = snapshot.threads.find((candidate) => candidate.id === options.threadId);
    const turn = thread?.latestTurn;
    if (turn && turn.state !== "running") {
      if (turn.state === "completed" && turn.assistantMessageId) {
        const message = thread?.messages.find(
          (candidate) => candidate.id === turn.assistantMessageId,
        );
        if (message) {
          return message.text;
        }
      }
      if (turn.state === "error") {
        return "GITS reported an error completing this turn — see the GITS conversation.";
      }
      break;
    }
  }
  return "Sent to GITS — the agent is still working; see the GITS conversation for the reply.";
}

async function read_stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const origin = process.env.GITS_ORIGIN;
  const token = process.env.GITS_TOKEN;
  const threadId = process.env.GITS_THREAD_ID;
  if (!origin || !token || !threadId) {
    process.stderr.write("crit-agent: GITS_ORIGIN, GITS_TOKEN, GITS_THREAD_ID are required\n");
    process.exit(1);
    return;
  }
  const stdin = await read_stdin();
  const timeoutMs = process.env.GITS_TURN_TIMEOUT_MS
    ? Number(process.env.GITS_TURN_TIMEOUT_MS)
    : undefined;
  try {
    const reply = await run_crit_agent({ origin, token, threadId, stdin, timeoutMs });
    process.stdout.write(reply);
  } catch (error) {
    process.stderr.write(`crit-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// Only run main when executed directly (not when imported by tests).
if (
  (process.argv[1] && process.argv[1].endsWith("crit-agent-cli.ts")) ||
  process.argv[1]?.endsWith("crit-agent-cli.js")
) {
  void main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-agent-cli.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/crit && rtk git commit -m "feat(crit): block-and-return agent wrapper CLI"
```

### Task 2d (if needed): Expose the shared subpath export

**Files:**

- Modify: `packages/shared/package.json`

- [ ] **Step 1: Check whether the import already resolves**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun typecheck`
If `@t3tools/shared/crit/review-comment-block` resolves, skip this task. If it errors with "cannot find module", continue.

- [ ] **Step 2: Add the subpath export**

In `packages/shared/package.json` `exports`, mirror the existing pattern (e.g. the `./git` entry) for `./crit/*`:

```json
"./crit/*": {
	"types": "./src/crit/*.ts",
	"default": "./src/crit/*.ts"
}
```

Match the exact field shape used by neighboring entries in that file.

- [ ] **Step 3: Verify + commit**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun typecheck`
Expected: PASS.

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add packages/shared/package.json && rtk git commit -m "chore(shared): export crit subpath"
```

---

## Phase 3 — Binary resolver (`apps/server/src/crit/crit-binary-resolver.ts`)

Resolves the crit binary path: env override first (`GITS_CRIT_BINARY`), then the packaged Electron resources dir (`process.resourcesPath/crit/<platform>-<arch>/crit[.exe]`), then PATH (`crit`) for dev.

### Task 3: Implement the resolver

**Files:**

- Create: `apps/server/src/crit/crit-binary-resolver.ts`
- Test: `apps/server/src/crit/crit-binary-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { resolve_crit_binary_relative_path } from "./crit-binary-resolver.ts";

describe("resolve_crit_binary_relative_path", () => {
  it("maps platform/arch to the bundled binary subpath", () => {
    expect(resolve_crit_binary_relative_path("darwin", "arm64")).toBe("crit/darwin-arm64/crit");
    expect(resolve_crit_binary_relative_path("linux", "x64")).toBe("crit/linux-x64/crit");
    expect(resolve_crit_binary_relative_path("win32", "x64")).toBe("crit/win32-x64/crit.exe");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-binary-resolver.test.ts`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement**

```typescript
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export function resolve_crit_binary_relative_path(platform: NodeJS.Platform, arch: string): string {
  const binary = platform === "win32" ? "crit.exe" : "crit";
  return `crit/${platform}-${arch}/${binary}`;
}

function is_executable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveCritBinaryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export function resolve_crit_binary_path(options: ResolveCritBinaryOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  const override = env.GITS_CRIT_BINARY?.trim();
  if (override && is_executable(override)) {
    return override;
  }

  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const bundled = join(resourcesPath, resolve_crit_binary_relative_path(platform, arch));
    if (is_executable(bundled)) {
      return bundled;
    }
  }

  // Dev fallback: rely on PATH lookup by returning the bare command.
  return "crit";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-binary-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/crit && rtk git commit -m "feat(crit): resolve bundled crit binary path"
```

---

## Phase 4 — Sidecar manager (`apps/server/src/crit/crit-sidecar-manager.ts`)

Spawns/lifecycles one crit process per workspace, mints a scoped session token, sets crit's `agent_cmd` to the wrapper, health-checks the served URL, and exposes status. **Model the Effect structure on an existing provider runtime** — read `apps/server/src/provider/opencodeRuntime.ts` and `apps/server/src/provider/Layers/CodexProvider.ts` first for the codebase's spawn/lifecycle/Layer conventions, and mirror them (process spawning via the platform Command service, `Effect.acquireRelease` for teardown, `Ref` for state).

### Task 4a: Define the manager interface and a pure port/spawn-spec helper

**Files:**

- Create: `apps/server/src/crit/crit-sidecar-manager.ts`
- Test: `apps/server/src/crit/crit-sidecar-manager.test.ts`

- [ ] **Step 1: Write the failing test (pure spawn-spec builder)**

```typescript
import { describe, expect, it } from "vitest";
import { build_crit_spawn_spec } from "./crit-sidecar-manager.ts";

describe("build_crit_spawn_spec", () => {
  it("binds to loopback and wires agent_cmd env for the wrapper", () => {
    const spec = build_crit_spawn_spec({
      binaryPath: "/opt/crit",
      repoRoot: "/work/repo",
      branch: "feature/x",
      host: "127.0.0.1",
      port: 4321,
      origin: "http://127.0.0.1:4310",
      token: "scoped-token",
      threadId: "thread-1",
      wrapperCommand: "node /app/crit-agent-cli.js",
    });

    // Flags are confirmed in Task 0b; assert the loopback bind + port are present.
    expect(spec.args).toContain("127.0.0.1");
    expect(spec.args).toContain("4321");
    expect(spec.env.GITS_ORIGIN).toBe("http://127.0.0.1:4310");
    expect(spec.env.GITS_TOKEN).toBe("scoped-token");
    expect(spec.env.GITS_THREAD_ID).toBe("thread-1");
    expect(spec.url).toBe("http://127.0.0.1:4321");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-sidecar-manager.test.ts`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement the pure helper**

> Replace the `args` array with the exact crit flags recorded in Task 0b. The names below (`--repo`, `--branch`, `--host`, `--port`, `--agent-cmd`) are placeholders for the real flags and MUST be corrected from `docs/crit-integration-notes.md`.

```typescript
export interface CritSpawnInput {
  readonly binaryPath: string;
  readonly repoRoot: string;
  readonly branch: string;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly threadId: string;
  readonly wrapperCommand: string;
}

export interface CritSpawnSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  readonly url: string;
}

export function build_crit_spawn_spec(input: CritSpawnInput): CritSpawnSpec {
  return {
    command: input.binaryPath,
    args: [
      "--repo",
      input.repoRoot,
      "--branch",
      input.branch,
      "--host",
      input.host,
      "--port",
      String(input.port),
      "--agent-cmd",
      input.wrapperCommand,
    ],
    env: {
      GITS_ORIGIN: input.origin,
      GITS_TOKEN: input.token,
      GITS_THREAD_ID: input.threadId,
    },
    url: `http://${input.host}:${input.port}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-sidecar-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/crit && rtk git commit -m "feat(crit): pure crit spawn-spec builder"
```

### Task 4b: Implement the Effect sidecar service (spawn, health-check, token, teardown)

**Files:**

- Modify: `apps/server/src/crit/crit-sidecar-manager.ts`
- Test: `apps/server/src/crit/crit-sidecar-manager.test.ts`

- [ ] **Step 1: Read the reference runtimes**

Read `apps/server/src/provider/opencodeRuntime.ts` end-to-end and note: which service spawns processes (the Command/Executor service), how teardown is registered (`Effect.acquireRelease`/scopes), how readiness is detected, and how auth sessions are issued (mirror `withProjectCliSessionToken` in `apps/server/src/cli/project.ts`, which uses `authControlPlane.issueSession({ role: "owner", label })` and revokes on release).

- [ ] **Step 2: Write the failing integration test**

```typescript
import { describe, expect, it } from "vitest";
import { CritSidecarManager } from "./crit-sidecar-manager.ts";

describe("CritSidecarManager", () => {
  it("starts a fake crit, reports ready with a loopback url, and tears down", async () => {
    // Use a fake binary (a tiny node http server script) as the crit stand-in via GITS_CRIT_BINARY,
    // asserting ensure_sidecar() returns status "ready" and a 127.0.0.1 url, then teardown stops it.
    // Implement using the project's Effect test harness (see *.test.ts in apps/server/src/provider for the pattern).
    expect(typeof CritSidecarManager).toBe("function");
  });
});
```

> Flesh out this test to match the Effect test conventions found in `apps/server/src/provider/Layers/*.test.ts` (those tests already spawn/observe provider processes — copy their harness setup). The assertion: `ensure_sidecar({ workspaceRoot, branch, threadId })` resolves to `{ status: "ready", url }` and a second call for the same workspace returns the same url (ref-counted reuse).

- [ ] **Step 3: Run test to verify it fails**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-sidecar-manager.test.ts`
Expected: FAIL — `CritSidecarManager` is not exported.

- [ ] **Step 4: Implement the service**

Implement `CritSidecarManager` as an Effect service mirroring `opencodeRuntime.ts`:

- State: `Ref` of `Map<workspaceRoot, { url, port, process, refCount, status }>`.
- `ensure_sidecar({ workspaceRoot, branch, threadId })`:
  1. If a ready entry exists, increment refCount and return its url.
  2. Else: resolve binary (`resolve_crit_binary_path`), pick a free ephemeral port (mirror how the codebase finds free ports; otherwise bind `0` and read back), issue a scoped session token (`authControlPlane.issueSession`), compute `wrapperCommand` (`node <path-to-built crit-agent-cli.js>`), `build_crit_spawn_spec`, spawn via the Command service inside `Effect.acquireRelease` (release: kill process + revoke token), poll the crit URL until healthy or timeout, set status `ready`, return url.
- `release_sidecar(workspaceRoot)`: decrement refCount; when zero, schedule idle-timeout teardown.
- `sidecar_status(workspaceRoot)`: return `starting | ready | crashed | stopped` + url.
- On process exit before release: mark `crashed`, surface via status.

Use the exact service/Layer idiom from the reference file (Context tag + `Layer.effect`).

- [ ] **Step 5: Run test to verify it passes**

Run: `PATH="$HOME/.local/bin:$PATH" rtk npx vitest run apps/server/src/crit/crit-sidecar-manager.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server/src/crit && rtk git commit -m "feat(crit): crit sidecar manager service"
```

---

## Phase 5 — Server transport: expose crit sidecar to the web app

Add `crit.ensureSidecar` and `crit.sidecarStatus` to the server's client-facing API so `apps/web` can request a crit URL for the active workspace + thread.

### Task 5: Wire the WS/HTTP methods

**Files:**

- Modify: `apps/server/src/wsServer.ts` (NativeApi methods)
- Modify: `packages/contracts/src/` (request/response schema for the new methods — follow the neighboring method schemas)
- Test: add a server method test mirroring the nearest existing `wsServer`/NativeApi test.

- [ ] **Step 1: Read the existing method-registration pattern**

Read `apps/server/src/wsServer.ts` and find where NativeApi methods are registered. Pick a simple existing method (request → server effect → response) as the template.

- [ ] **Step 2: Add schemas**

In `packages/contracts`, define:

```typescript
// CritEnsureSidecarRequest
{ workspaceRoot: TrimmedNonEmptyString, branch: TrimmedNonEmptyString, threadId: ThreadId }
// CritSidecarStatusResponse
{ status: Schema.Literals(["starting", "ready", "crashed", "stopped"]), url: Schema.NullOr(Schema.String) }
```

Match the file/module the neighboring NativeApi method schemas live in.

- [ ] **Step 3: Register the methods**

In `wsServer.ts`, register `crit.ensureSidecar` → `CritSidecarManager.ensure_sidecar(...)` and `crit.sidecarStatus` → `CritSidecarManager.sidecar_status(...)`, returning the response schema. Provide the `CritSidecarManager` layer where the server builds its runtime.

- [ ] **Step 4: Typecheck + test + commit**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun typecheck && rtk npx vitest run apps/server`
Expected: PASS.

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/server packages/contracts && rtk git commit -m "feat(crit): expose crit sidecar over NativeApi"
```

---

## Phase 6 — Web PR view panel (`apps/web`)

Render crit's URL in an iframe that replaces the sidebar `DiffPanel` for PR review, behind a feature flag, with status/fallback handling.

### Task 6a: localApi client methods

**Files:**

- Modify: `apps/web/src/localApi.ts`

- [ ] **Step 1: Add client wrappers**

Mirror an existing `localApi` method to add:

```typescript
crit_ensure_sidecar(input: { workspaceRoot: string; branch: string; threadId: string }): Promise<{ status: string; url: string | null }>
crit_sidecar_status(input: { workspaceRoot: string }): Promise<{ status: string; url: string | null }>
```

Use the same call/transport helper neighboring methods use.

- [ ] **Step 2: Typecheck + commit**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun typecheck`
Expected: PASS.

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/web/src/localApi.ts && rtk git commit -m "feat(crit): localApi methods for crit sidecar"
```

### Task 6b: CritReviewPanel component

**Files:**

- Create: `apps/web/src/components/CritReviewPanel.tsx`

- [ ] **Step 1: Implement the panel**

```tsx
import { useEffect, useState } from "react";
import { DiffPanelShell, DiffPanelLoadingState } from "./DiffPanelShell";
import { readLocalApi } from "../localApi";

interface CritReviewPanelProps {
  readonly workspaceRoot: string;
  readonly branch: string;
  readonly threadId: string;
  readonly onUnavailable: () => void;
}

type CritState = {
  readonly status: "starting" | "ready" | "crashed" | "stopped";
  readonly url: string | null;
};

export function CritReviewPanel(props: CritReviewPanelProps) {
  const [state, set_state] = useState<CritState>({ status: "starting", url: null });

  useEffect(() => {
    let cancelled = false;
    const ensure = async () => {
      try {
        const result = await readLocalApi().crit_ensure_sidecar({
          workspaceRoot: props.workspaceRoot,
          branch: props.branch,
          threadId: props.threadId,
        });
        if (!cancelled) {
          set_state(result as CritState);
          if (result.status === "crashed" || result.status === "stopped") {
            props.onUnavailable();
          }
        }
      } catch {
        if (!cancelled) {
          props.onUnavailable();
        }
      }
    };
    void ensure();
    return () => {
      cancelled = true;
    };
  }, [props.workspaceRoot, props.branch, props.threadId, props.onUnavailable]);

  if (state.status !== "ready" || !state.url) {
    return (
      <DiffPanelShell mode="sidebar" header={null}>
        <DiffPanelLoadingState label="Starting crit review…" />
      </DiffPanelShell>
    );
  }

  return (
    <DiffPanelShell mode="sidebar" header={null}>
      <iframe
        title="Crit review"
        src={state.url}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-forms allow-same-origin"
      />
    </DiffPanelShell>
  );
}
```

> Confirm `DiffPanelShell`'s `header` prop accepts `null` (the skeleton path passes a node). If it requires a node, pass `<div />`.

- [ ] **Step 2: Typecheck + commit**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun typecheck`
Expected: PASS.

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/web/src/components/CritReviewPanel.tsx && rtk git commit -m "feat(crit): CritReviewPanel iframe component"
```

### Task 6c: Route wiring behind a feature flag

**Files:**

- Modify: `apps/web/src/routes/_chat.$environmentId.$threadId.tsx:134`

- [ ] **Step 1: Gate the sidebar render**

Replace:

```tsx
{
  renderDiffContent ? <LazyDiffPanel mode="sidebar" /> : null;
}
```

with a flag-checked branch that prefers crit for PR review and falls back to the native panel:

```tsx
{
  renderDiffContent ? (
    crit_review_enabled && active_pull_request ? (
      <CritReviewPanel
        workspaceRoot={workspace_root}
        branch={active_branch}
        threadId={thread_id}
        onUnavailable={disable_crit_review}
      />
    ) : (
      <LazyDiffPanel mode="sidebar" />
    )
  ) : null;
}
```

Add `crit_review_enabled` from settings (default off for v1) and a local `disable_crit_review` state setter for the fallback. Source `workspace_root`, `active_branch`, `active_pull_request`, and `thread_id` from the route's existing store selectors (the surrounding component already has the thread/environment context; reuse `useVcsStatus` / the PR resolution from `sourceControlActions.ts` for the PR + branch).

- [ ] **Step 2: Add the settings toggle**

Add a boolean `critReview` setting following the existing settings pattern in `packages/contracts/src/settings.ts`, surfaced in `apps/web/src/components/settings/` (mirror an existing toggle). Default `false`.

- [ ] **Step 3: Typecheck + lint + test + commit**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun typecheck && rtk bun lint && rtk npx vitest run apps/web`
Expected: PASS.

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add apps/web packages/contracts && rtk git commit -m "feat(crit): render crit review panel in PR view behind a flag"
```

---

## Phase 7 — Bundle crit binaries (Electron)

Ship per-platform crit binaries via electron-builder `extraResources` so `resolve_crit_binary_path` finds them under `process.resourcesPath`.

### Task 7: Add binaries to the desktop artifact

**Files:**

- Modify: `scripts/build-desktop-artifact.ts`
- Create: `resources/crit/<platform>-<arch>/crit[.exe]` (populated per built platform)

- [ ] **Step 1: Read the build script**

Read `scripts/build-desktop-artifact.ts` to find where the electron-builder config object is constructed (`extraResources`, `directories`, `files`).

- [ ] **Step 2: Add extraResources entry**

Add the crit binaries to `extraResources` so they land at `resources/crit/...`:

```ts
extraResources: [
	// ...existing entries...
	{ from: "resources/crit", to: "crit", filter: ["**/*"] },
],
```

Match the exact array/field shape already present in the script.

- [ ] **Step 3: Place the dev-platform binary**

Copy the binary built in Task 0b into the resolver's expected path for the current platform, e.g.:

```bash
mkdir -p resources/crit/linux-x64 && cp /tmp/crit resources/crit/linux-x64/crit && chmod +x resources/crit/linux-x64/crit
```

Add `resources/crit/` to `.gitignore` if binaries should not be committed (CI fetches/builds them); otherwise commit via Git LFS. Record the chosen approach in `docs/crit-integration-notes.md`.

- [ ] **Step 4: Smoke-check the resolver against the packaged path**

Run a node one-liner asserting `resolve_crit_binary_path({ resourcesPath: "resources", platform: "linux", arch: "x64" })` returns the placed binary. Expected: the `resources/crit/linux-x64/crit` path.

- [ ] **Step 5: Commit**

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add scripts/build-desktop-artifact.ts .gitignore docs/crit-integration-notes.md && rtk git commit -m "build(crit): bundle crit binary via electron extraResources"
```

---

## Phase 8 — End-to-end verification

### Task 8: Drive the PR view + crit webview headlessly

**Files:**

- Create: an E2E script under the repo's existing headless verify harness location.

- [ ] **Step 1: Boot GITS headlessly**

Use the documented headless harness (pairing token + isolated `T3CODE_HOME` + vite env) to start the app with the `critReview` flag enabled on a seeded test repo that has an open PR/branch.

- [ ] **Step 2: Drive the flow with Playwright**

Open the PR view, assert the crit iframe loads (status `ready`, `127.0.0.1` URL), select a line range in crit, submit a comment, and assert a new `thread.turn.start` lands on the active thread (observe via the orchestration snapshot/events) and that an assistant reply returns into crit's thread.

- [ ] **Step 3: Run + commit**

Run the harness; capture pass/fail. On pass:

```bash
PATH="$HOME/.local/bin:$PATH" rtk git add <e2e-script-path> && rtk git commit -m "test(crit): e2e PR view crit review flow"
```

- [ ] **Step 4: Full gate**

Run: `PATH="$HOME/.local/bin:$PATH" rtk bun fmt && rtk bun lint && rtk bun typecheck && rtk bun run test`
Expected: all PASS. Fix any failures before considering the feature complete.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Binary bundling → Phase 7 + Task 3. Sidecar manager → Phase 4. PR view embed → Phase 6. Wrapper CLI → Phase 2. Config/auth → Phase 4 (token) + Phase 6c (flag). Data flow → Phases 2/4/6. Failure handling → Task 2c (timeout/error), Task 4b (crash/refcount), Task 6b (unavailable fallback). Security (loopback, scoped token, license) → Tasks 0a, 4b, 3. Testing → Tasks 1–8. Block-and-return → Task 2c. Why-codex-is-fine → realized structurally (wrapper is the `agent_cmd`; no task needs codex).
- **Known assumptions gated by discovery:** crit CLI flags (Task 4a/0b), crit stdin format (Task 2a/0c), electron-builder mechanism (Task 7/Step 1), exact Effect service idiom (Task 4b/Step 1). These are explicit inspect-then-match steps, not silent guesses.
- **Type consistency:** `build_review_comment_block` / `NormalizedComment` / `build_turn_start_command` / `run_crit_agent` / `resolve_crit_binary_path` / `build_crit_spawn_spec` / `CritSidecarManager` used consistently across phases.

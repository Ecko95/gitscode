// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off
// Standalone child-process CLI spawned by crit as its agent_cmd. It is deliberately
// dependency-light (global fetch, node timers, plain Date) and is NOT an Effect program,
// so the Effect runtime diagnostics that apply to the rest of apps/server are disabled here.
import { build_review_comment_block } from "@t3tools/shared/crit/review-comment-block";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedComment {
  readonly text: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly diff: string;
}

// Shape per docs/crit-integration-notes.md "## agent_cmd stdin" (PENDING Task 0c).
// crit's exact payload is unconfirmed; assume JSON with a plain-text fallback.
interface CritStdinPayload {
  readonly comment?: string;
  readonly quoted?: string;
  readonly filePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

interface CritTurnResponse {
  readonly priorTurnId: string | null;
}

interface CritTurnStatusResponse {
  readonly state: "pending" | "completed" | "error" | "interrupted";
  readonly assistantMessageId: string | null;
  readonly reply: string | null;
}

export interface RunCritAgentOptions {
  readonly origin: string;
  readonly token: string;
  readonly threadId: string;
  readonly stdin: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

// ---------------------------------------------------------------------------
// parse_crit_payload
// ---------------------------------------------------------------------------

export function parse_crit_payload(raw: string): NormalizedComment {
  let payload: CritStdinPayload;
  try {
    payload = JSON.parse(raw) as CritStdinPayload;
  } catch {
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

// ---------------------------------------------------------------------------
// build_review_text
// ---------------------------------------------------------------------------

export function build_review_text(comment: NormalizedComment): string {
  return build_review_comment_block({
    filePath: comment.filePath,
    sectionId: `crit:${comment.filePath}:${comment.startIndex}-${comment.endIndex}`,
    sectionTitle: "Crit review",
    rangeLabel: comment.startIndex === comment.endIndex ? "line" : "lines",
    startIndex: comment.startIndex,
    endIndex: comment.endIndex,
    text: comment.text,
    diff: comment.diff,
  });
}

// ---------------------------------------------------------------------------
// run_crit_agent
// ---------------------------------------------------------------------------

const ERROR_ACK = "GITS reported an error completing this turn — see the GITS conversation.";
const STILL_WORKING_ACK =
  "Sent to GITS — the agent is still working; see the GITS conversation for the reply.";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function start_turn(options: RunCritAgentOptions, text: string): Promise<string | null> {
  const response = await fetch(`${options.origin}/api/crit/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ threadId: options.threadId, text }),
  });
  if (!response.ok) {
    throw new Error(`GITS turn failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as CritTurnResponse;
  return payload.priorTurnId ?? null;
}

async function read_turn_status(
  options: RunCritAgentOptions,
  priorTurnId: string | null,
): Promise<CritTurnStatusResponse> {
  const params = new URLSearchParams({ threadId: options.threadId });
  if (priorTurnId !== null && priorTurnId.length > 0) {
    params.set("priorTurnId", priorTurnId);
  }
  const response = await fetch(`${options.origin}/api/crit/turn-status?${params.toString()}`, {
    headers: { accept: "application/json", authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) {
    throw new Error(`GITS turn-status failed (${response.status})`);
  }
  return (await response.json()) as CritTurnStatusResponse;
}

export async function run_crit_agent(options: RunCritAgentOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const comment = parse_crit_payload(options.stdin);
  const text = build_review_text(comment);

  // The server captures the baseline prior turn and correlates the started turn
  // for us; we only forward the opaque priorTurnId it returns on each poll.
  const priorTurnId = await start_turn(options, text);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const status = await read_turn_status(options, priorTurnId);
    if (status.state === "pending") {
      continue;
    }
    if (status.state === "completed") {
      return status.reply ?? STILL_WORKING_ACK;
    }
    if (status.state === "error") {
      return ERROR_ACK;
    }
    // "interrupted" or any other terminal state — stop and ack.
    break;
  }
  return STILL_WORKING_ACK;
}

// ---------------------------------------------------------------------------
// main (entry point guard — does not run during import/tests)
// ---------------------------------------------------------------------------

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
  const timeout_override: { timeoutMs?: number } = {};
  if (process.env.GITS_TURN_TIMEOUT_MS) {
    timeout_override.timeoutMs = Number(process.env.GITS_TURN_TIMEOUT_MS);
  }
  try {
    const reply = await run_crit_agent({ origin, token, threadId, stdin, ...timeout_override });
    process.stdout.write(reply);
  } catch (error) {
    process.stderr.write(`crit-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const invoked_path = process.argv[1] ?? "";
if (invoked_path.endsWith("crit-agent-cli.ts") || invoked_path.endsWith("crit-agent-cli.js")) {
  void main();
}

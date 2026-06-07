import { randomUUID } from "node:crypto";

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

interface SnapshotThread {
	readonly id: string;
	readonly latestTurn: { readonly state: string; readonly assistantMessageId: string | null } | null;
	readonly messages: ReadonlyArray<{ readonly id: string; readonly role: string; readonly text: string }>;
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
// build_turn_start_command
// ---------------------------------------------------------------------------

export function build_turn_start_command(threadId: string, comment: NormalizedComment): ThreadTurnStartCommandBody {
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

// ---------------------------------------------------------------------------
// run_crit_agent
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function dispatch_command(options: RunCritAgentOptions, command: ThreadTurnStartCommandBody): Promise<void> {
	const response = await fetch(`${options.origin}/api/orchestration/dispatch`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${options.token}` },
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
				const message = thread?.messages.find((candidate) => candidate.id === turn.assistantMessageId);
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
	const timeoutMs = process.env.GITS_TURN_TIMEOUT_MS ? Number(process.env.GITS_TURN_TIMEOUT_MS) : undefined;
	try {
		const reply = await run_crit_agent({ origin, token, threadId, stdin, timeoutMs });
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

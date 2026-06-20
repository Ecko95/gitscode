import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { AutomodeGoal, PeerStatus } from "@t3tools/contracts";

import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeDriver, type AutomodeDriverShape } from "../Services/AutomodeDriver.ts";

const TICK_INTERVAL_MS = (() => {
	const raw = process.env.GITS_AUTOMODE_DRIVER_TICK_MS?.trim();
	const parsed = raw === undefined || raw === "" ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

const TERMINAL_FAIL_STATUSES = new Set<PeerStatus>(["failed", "frozen", "killed", "halted"]);
const TERMINAL_DONE_STATUSES = new Set<PeerStatus>(["done", "completed"]);

function oldestQueued(goals: ReadonlyArray<AutomodeGoal>): AutomodeGoal | null {
	// The snapshot sorts goals newest-first; reverse before sorting so that
	// equal-timestamp goals remain in oldest-first (FIFO) order.
	const queued = [...goals]
		.reverse()
		.filter((goal) => goal.status === "queued")
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	return queued[0] ?? null;
}

export const AutomodeDriverLive = Layer.effect(
	AutomodeDriver,
	Effect.gen(function* () {
		const supervisor = yield* AutomodeSupervisor;
		const delamainAdapter = yield* DelamainAdapter;

		const tickOnce: AutomodeDriverShape["tickOnce"] = () =>
			Effect.gen(function* () {
				const snapshot = yield* supervisor.getSnapshot();

				// Only act in autonomous mode with the kill switch off.
				if (snapshot.policy.mode !== "autonomous" || snapshot.policy.killSwitchEnabled) {
					return;
				}

				// 1) Reconcile the in-flight goal (sequential: at most one running).
				const running = snapshot.goals.find(
					(goal) => goal.status === "running" && goal.peerId !== null,
				);
				if (running !== undefined) {
					const peers = yield* delamainAdapter.listPeers().pipe(
						Effect.map((result) => result.peers),
						Effect.catch(() => Effect.succeed([])),
					);
					const peer = peers.find((candidate) => candidate.id === running.peerId);
					if (peer === undefined) {
						// The in-flight peer vanished from delamain (reaped or crashed after
						// finishing). A silent return would leave this goal stuck "running"
						// forever and deadlock the whole queue invisibly, so halt loudly and
						// let an operator resume if it was transient.
						yield* supervisor.haltDriver({
							reason: `Halted: peer ${running.peerId} for "${running.title}" not found in delamain (vanished or reaped) — manual check needed.`,
						});
						return;
					}

					if (peer.integrationStatus === "failed" || TERMINAL_FAIL_STATUSES.has(peer.status)) {
						yield* supervisor.failGoal({
							goalId: running.id,
							reason: `Peer ${peer.id} ended as ${peer.status}.`,
						});
						yield* supervisor.haltDriver({
							reason: `Halted: ${running.title} failed (${peer.status}).`,
						});
						return;
					}
					if (peer.status === "waiting") {
						yield* supervisor.haltDriver({
							reason: `Halted: peer ${peer.id} is waiting on input for ${running.title}.`,
						});
						return;
					}
					if (TERMINAL_DONE_STATUSES.has(peer.status)) {
						yield* supervisor.completeGoal({ goalId: running.id });
						yield* Effect.logInfo("gits.automode.driver.goal-completed", {
							goalId: running.id,
							peerId: peer.id,
						});
						return;
					}
					return; // pending / running / blocked → still in flight
				}

				// 2) Idle: if halted, wait for an operator resume.
				if (snapshot.driverHalted) {
					return;
				}

				// 3) Dispatch the oldest queued goal (sequential start).
				const next = oldestQueued(snapshot.goals);
				if (next === null) {
					return;
				}
				const result = yield* supervisor.dispatchGoal({ goalId: next.id });
				if (result.peer === null) {
					yield* supervisor.haltDriver({
						reason: result.blockedReason ?? `Dispatch of ${next.title} did not spawn a peer.`,
					});
				}
			});

		// Forked, scoped polling fiber — runs for the lifetime of the layer.
		// Sleep first so that tests can call tickOnce() directly without
		// the background fiber racing on the first iteration.
		yield* Effect.forever(
			Effect.sleep(Duration.millis(TICK_INTERVAL_MS)).pipe(
				Effect.andThen(tickOnce()),
				// Mirror ProviderSessionReaper: recover ONLY from typed failures and
				// defects, never from interruption. catch/catchDefect both leave
				// interruption untouched, so a scope-close/shutdown interrupt tears the
				// loop down cleanly instead of being swallowed and restarting forever.
				Effect.catch((error) =>
					Effect.logWarning("gits.automode.driver.tick-failed", { error: error.message }),
				),
				Effect.catchDefect((defect) =>
					Effect.logWarning("gits.automode.driver.tick-defect", { defect }),
				),
			),
		).pipe(Effect.forkScoped);

		yield* Effect.logInfo("gits.automode.driver.started", { tickIntervalMs: TICK_INTERVAL_MS });

		return { tickOnce } satisfies AutomodeDriverShape;
	}),
);

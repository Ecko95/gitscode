import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { DelamainPeer, DelamainPeerListResult, PeerStatus } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor, type AutomodeSupervisorShape } from "../Services/AutomodeSupervisor.ts";
import { AutomodeUsageMeter } from "../Services/AutomodeUsageMeter.ts";
import { AutomodeDriver } from "../Services/AutomodeDriver.ts";
import { AutomodeSupervisorLive } from "./AutomodeSupervisor.ts";
import { AutomodeDriverLive } from "./AutomodeDriver.ts";

const basePeer: DelamainPeer = {
	id: "peer-driver",
	name: "Driver Peer",
	engine: "codex",
	model: "gpt-5.5",
	status: "running",
	rawStatus: "running",
	integrationStatus: null,
	sourceRepo: "/tmp/source-repo",
	worktreePath: "/tmp/source-repo/.worktrees/peer-driver",
	branch: "codex-peer/peer-driver",
	baseBranch: "gits",
	mergeBranch: "gits",
	prUrl: null,
	task: "Driver task",
	lastEvent: "running",
	startedAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	finishedAt: null,
};

const emptyList: Omit<DelamainPeerListResult, "peers"> = {
	capabilities: {
		available: true,
		binaryPath: "delamain",
		supported: ["list", "spawn"],
		unsupported: ["status", "log", "kill", "reply", "wait", "integrate"],
		checkedAt: "2026-01-01T00:00:00.000Z",
	},
};

// Mutable holder so a test can change what listPeers returns between ticks.
function makeLayer(peerStatus: { current: PeerStatus | "absent" }) {
	const spawnedPeerId = basePeer.id;
	const delamain = Layer.mock(DelamainAdapter)({
		listPeers: () =>
			Effect.succeed({
				...emptyList,
				peers:
					peerStatus.current === "absent"
						? []
						: [{ ...basePeer, status: peerStatus.current, rawStatus: peerStatus.current }],
			}),
		spawnPeer: (input) =>
			Effect.succeed({
				...basePeer,
				id: spawnedPeerId,
				name: input.name ?? basePeer.name,
				model: input.model ?? basePeer.model,
				sourceRepo: input.repo,
				task: input.prompt,
				status: "running",
				rawStatus: "running",
			}),
		killPeer: () => Effect.succeed({ ...basePeer, status: "killed", rawStatus: "killed" }),
	});
	const usage = Layer.mock(AutomodeUsageMeter)({
		readBudgetUsage: () =>
			Effect.succeed({
				source: "unavailable",
				totalCostUsd: null,
				totalProcessedTokens: null,
				updatedAt: null,
				note: "n/a",
			}),
	});
	const config = ServerConfig.layerTest(process.cwd(), { prefix: "gits-automode-driver-test-" }).pipe(
		Layer.provide(NodeServices.layer),
	);
	const supervisor = AutomodeSupervisorLive.pipe(
		Layer.provide(delamain),
		Layer.provide(usage),
		Layer.provideMerge(config),
		Layer.provideMerge(NodeServices.layer),
	);
	return AutomodeDriverLive.pipe(Layer.provideMerge(supervisor), Layer.provide(delamain));
}

function armAutonomous(supervisor: AutomodeSupervisorShape) {
	return supervisor.updatePolicy({
		mode: "autonomous",
		killSwitchEnabled: false,
		maxActivePeers: 1,
		allowedRepos: ["/tmp/source-repo"],
		requireApprovalForPeerSpawn: false,
		requireApprovalBeforeIntegrate: false,
		requireApprovalBeforeDestructiveAction: false,
	});
}

describe("AutomodeDriver", () => {
	it.effect("dispatches the oldest queued goal when idle and autonomous", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			yield* armAutonomous(supervisor);
			yield* supervisor.enqueueGoal({ title: "First", repo: "/tmp/source-repo", prompt: "do it" });

			yield* driver.tickOnce();

			const snapshot = yield* supervisor.getSnapshot();
			const goal = snapshot.goals.find((g) => g.title === "First");
			assert.equal(goal?.status, "running");
			assert.equal(goal?.peerId, "peer-driver");
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});

	it.effect("does not dispatch a second goal while one is running (sequential)", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			yield* armAutonomous(supervisor);
			yield* supervisor.enqueueGoal({ title: "A", repo: "/tmp/source-repo", prompt: "a" });
			yield* supervisor.enqueueGoal({ title: "B", repo: "/tmp/source-repo", prompt: "b" });

			yield* driver.tickOnce(); // dispatch one
			peerStatus.current = "running"; // it's now in flight
			yield* driver.tickOnce(); // must NOT dispatch the second

			const snapshot = yield* supervisor.getSnapshot();
			const running = snapshot.goals.filter((g) => g.status === "running");
			assert.equal(running.length, 1);
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});

	it.effect("reconciles a done peer to completed and advances", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			yield* armAutonomous(supervisor);
			yield* supervisor.enqueueGoal({ title: "Only", repo: "/tmp/source-repo", prompt: "x" });

			yield* driver.tickOnce(); // dispatch → running, peer "peer-driver"
			peerStatus.current = "done"; // peer finishes
			yield* driver.tickOnce(); // reconcile → completed

			const snapshot = yield* supervisor.getSnapshot();
			assert.equal(snapshot.goals.find((g) => g.title === "Only")?.status, "completed");
			assert.equal(snapshot.driverHalted, false);
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});

	it.effect("reconciles a failed peer to failed and halts the chain", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			yield* armAutonomous(supervisor);
			yield* supervisor.enqueueGoal({ title: "Boom", repo: "/tmp/source-repo", prompt: "x" });
			yield* supervisor.enqueueGoal({ title: "Next", repo: "/tmp/source-repo", prompt: "y" });

			yield* driver.tickOnce(); // dispatch "Boom"
			peerStatus.current = "failed";
			yield* driver.tickOnce(); // reconcile → failed + halt
			yield* driver.tickOnce(); // halted: must NOT dispatch "Next"

			const snapshot = yield* supervisor.getSnapshot();
			assert.equal(snapshot.goals.find((g) => g.title === "Boom")?.status, "failed");
			assert.equal(snapshot.driverHalted, true);
			assert.equal(snapshot.goals.find((g) => g.title === "Next")?.status, "queued");
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});

	it.effect("halts on a waiting peer without failing the goal", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			yield* armAutonomous(supervisor);
			yield* supervisor.enqueueGoal({ title: "Ask", repo: "/tmp/source-repo", prompt: "x" });

			yield* driver.tickOnce(); // dispatch
			peerStatus.current = "waiting";
			yield* driver.tickOnce(); // reconcile → halt, goal still running

			const snapshot = yield* supervisor.getSnapshot();
			assert.equal(snapshot.goals.find((g) => g.title === "Ask")?.status, "running");
			assert.equal(snapshot.driverHalted, true);
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});

	it.effect("halts (does not silently advance) when the in-flight peer vanishes", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			yield* armAutonomous(supervisor);
			yield* supervisor.enqueueGoal({ title: "Gone", repo: "/tmp/source-repo", prompt: "x" });

			yield* driver.tickOnce(); // dispatch → running, peer "peer-driver"
			peerStatus.current = "running"; // it's in flight
			yield* driver.tickOnce(); // still running, peer visible
			peerStatus.current = "absent"; // peer vanished / reaped
			yield* driver.tickOnce(); // reconcile → must halt, not advance

			const snapshot = yield* supervisor.getSnapshot();
			assert.equal(snapshot.goals.find((g) => g.title === "Gone")?.status, "running");
			assert.equal(snapshot.driverHalted, true);
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});

	it.effect("does nothing when not autonomous", () => {
		const peerStatus = { current: "absent" as PeerStatus | "absent" };
		return Effect.gen(function* () {
			const supervisor = yield* AutomodeSupervisor;
			const driver = yield* AutomodeDriver;
			// policy left at default (mode "manual", kill switch on)
			yield* supervisor.enqueueGoal({ title: "Idle", repo: "/tmp/source-repo", prompt: "x" });

			yield* driver.tickOnce();

			const snapshot = yield* supervisor.getSnapshot();
			assert.equal(snapshot.goals.find((g) => g.title === "Idle")?.status, "queued");
		}).pipe(Effect.provide(makeLayer(peerStatus)));
	});
});

// Phase-1 e2e driver — slot scheduler + arming + reArmOnBoot (spec E2E section).
// Run from apps/server: node phase1-e2e-driver.ts <phase>
// Phases: enable-arm | seed-goal | expect-queued | expect-boot-disarm | rearm-after-boot | expect-dispatch | snap
// Env: T3_BASE (http://127.0.0.1:PORT), T3_BEARER, E2E_REPO (fake repo path)
import { WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const BASE = process.env.T3_BASE ?? "http://127.0.0.1:39775";
const BEARER = process.env.T3_BEARER;
const REPO = process.env.E2E_REPO ?? "/tmp/phase1-e2e-fake-repo";
if (!BEARER) throw new Error("T3_BEARER is required");

async function wsToken(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/ws-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${BEARER}` },
  });
  if (!res.ok) throw new Error(`ws-token failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

const protocolLayer = (wsUrl: string) => {
  const ctor = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => new WebSocket(socketUrl, protocols) as globalThis.WebSocket,
  );
  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(ctor))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeClient = RpcClient.make(WsRpcGroup);
type Client = typeof makeClient extends Effect.Effect<infer C, any, any> ? C : never;

// ponytail: wsToken TTL is 5 min — mint fresh per connection instead of caching one.
async function run<A>(f: (c: Client) => Effect.Effect<A, any, any>): Promise<A> {
  const token = await wsToken();
  const wsUrl = `${BASE.replace(/^http/, "ws")}/ws?wsToken=${encodeURIComponent(token)}`;
  return Effect.runPromise(
    Effect.scoped(makeClient.pipe(Effect.flatMap(f), Effect.provide(protocolLayer(wsUrl)))),
  );
}

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string): never => {
  console.error(`E2E FAIL: ${m}`);
  process.exit(1);
};

async function schedulerSnap(): Promise<any> {
  return run((c) => c[WS_METHODS.gitsAutomodeSchedulerSnapshot]({}));
}
async function automodeSnap(): Promise<any> {
  return run((c) => c[WS_METHODS.gitsAutomodeGetSnapshot]({}));
}

async function main() {
  const phase = process.argv[2] ?? fail("phase argument required");

  if (phase === "snap") {
    const s = await schedulerSnap();
    const a = await automodeSnap();
    log(`scheduler: ${JSON.stringify(s)}`);
    log(
      `goals: ${JSON.stringify((a.goals ?? []).map((g: any) => ({ id: g.id, status: g.status, episodeId: g.episodeId })))} halted=${a.driverHalted} reason=${a.driverHaltedReason}`,
    );
    return;
  }

  if (phase === "enable-arm") {
    await run((c) => c[WS_METHODS.gitsAutomodeSchedulerSetConfig]({ enabled: true }));
    const snap = (await run((c) => c[WS_METHODS.gitsAutomodeSchedulerArm]({}))) as any;
    if (snap.arming?.status !== "armed") fail(`expected armed, got ${JSON.stringify(snap.arming)}`);
    if (!snap.arming?.nightKey) fail("armed without nightKey");
    log(`ARMED for night ${snap.arming.nightKey} (config=${JSON.stringify(snap.config)})`);
    return;
  }

  if (phase === "seed-goal") {
    await run((c) =>
      c[WS_METHODS.gitsAutomodeUpdatePolicy]({
        mode: "autonomous",
        killSwitchEnabled: false,
        maxActivePeers: 1,
        maxRuntimeMinutes: 5,
        maxBudgetUsd: null,
        allowedRepos: [REPO],
        requireApprovalForPeerSpawn: false,
        requireApprovalBeforeIntegrate: false,
        requireApprovalBeforeDestructiveAction: false,
        integrationBranch: null,
        verificationCommands: [],
      }),
    );
    const snap = (await run((c) =>
      c[WS_METHODS.gitsAutomodeEnqueueGoal]({
        title: "phase1 e2e goal",
        prompt: "e2e no-op goal (never expected to complete)",
        repo: REPO,
      }),
    )) as any;
    const goal = (snap.goals ?? []).find((g: any) => g.title === "phase1 e2e goal");
    if (!goal) fail("goal not enqueued");
    if (!/^epi-/.test(goal.episodeId ?? ""))
      fail(`goal missing minted episodeId: ${JSON.stringify(goal.episodeId)}`);
    log(`goal queued: ${goal.id} episode=${goal.episodeId}`);
    return;
  }

  if (phase === "expect-queued") {
    // ~6 driver ticks: the goal must STAY queued with an outside-slot gate decision, no halt.
    await sleep(8_000);
    const a = await automodeSnap();
    const s = await schedulerSnap();
    const goal = (a.goals ?? []).find((g: any) => g.title === "phase1 e2e goal");
    if (!goal) fail("goal vanished");
    if (goal.status !== "queued")
      fail(`expected queued, got ${goal.status} (${goal.blockedReason})`);
    if (a.driverHalted) fail(`driver halted: ${a.driverHaltedReason}`);
    const reason = s.lastGateDecision?.reason ?? "";
    if (!/outside slot window/i.test(reason))
      fail(`expected outside-slot gate decision, got: ${JSON.stringify(s.lastGateDecision)}`);
    log(`DENY VERIFIED: goal queued, gate="${reason}"`);
    return;
  }

  if (phase === "expect-boot-disarm") {
    const s = await schedulerSnap();
    if (s.arming?.status !== "disarmed")
      fail(`expected disarmed after boot, got ${JSON.stringify(s.arming)}`);
    if (!/restarted/i.test(s.arming?.disarmedReason ?? ""))
      fail(`expected restart reason, got: ${s.arming?.disarmedReason}`);
    log(`BOOT-DISARM VERIFIED: "${s.arming.disarmedReason}"`);
    return;
  }

  if (phase === "rearm-after-boot") {
    // reArmOnBoot re-armed the kill switch and cleared approvals; scheduler force-disarmed.
    await run((c) => c[WS_METHODS.gitsAutomodeUpdatePolicy]({ killSwitchEnabled: false }));
    const snap = (await run((c) => c[WS_METHODS.gitsAutomodeSchedulerArm]({}))) as any;
    if (snap.arming?.status !== "armed") fail(`re-arm failed: ${JSON.stringify(snap.arming)}`);
    log(`RE-ARMED for night ${snap.arming.nightKey}`);
    return;
  }

  if (phase === "expect-dispatch") {
    // Gate must OPEN: lastGateDecision.allowed flips true and a dispatch is attempted.
    // (A failed spawnPeer makes dispatchGoal fail as a typed error the driver loop
    // logs as tick-failed — no halt — so the gate decision is the crisp signal;
    // goal-left-queued and a spawn halt are accepted alternates.)
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const a = await automodeSnap();
      const s = await schedulerSnap();
      const goal = (a.goals ?? []).find((g: any) => g.title === "phase1 e2e goal");
      if (!goal) fail("goal vanished");
      if (goal.status !== "queued") {
        log(`DISPATCH VERIFIED: goal ${goal.status} (${goal.blockedReason ?? "-"})`);
        return;
      }
      if (a.driverHalted && /spawn/i.test(a.driverHaltedReason ?? "")) {
        log(`DISPATCH VERIFIED via spawn-failure halt: "${a.driverHaltedReason}"`);
        return;
      }
      if (a.driverHalted) fail(`driver halted for unexpected reason: ${a.driverHaltedReason}`);
      if (s.lastGateDecision?.allowed === true) {
        log(
          `DISPATCH VERIFIED via gate decision: ${JSON.stringify(s.lastGateDecision)} (spawn expected to fail in e2e env)`,
        );
        return;
      }
      await sleep(3_000);
    }
    const s = await schedulerSnap();
    fail(`no dispatch within 60s; lastGateDecision=${JSON.stringify(s.lastGateDecision)}`);
  }

  fail(`unknown phase ${phase}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

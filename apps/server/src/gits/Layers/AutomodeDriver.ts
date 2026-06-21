import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AutomodeSupervisorError, type AutomodeGoal, type PeerStatus } from "@t3tools/contracts";

import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeDriver, type AutomodeDriverShape } from "../Services/AutomodeDriver.ts";
import { GitsReviewPipeline } from "../Services/GitsReviewPipeline.ts";
import { AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { AutomodeHeldPr } from "../Services/AutomodeHeldPr.ts";
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { decide_automode_gate } from "./AutomodeReviewGate.ts";

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
    const reviewPipeline = yield* GitsReviewPipeline;
    const landing = yield* AutomodeLanding;
    const heldPr = yield* AutomodeHeldPr;
    const ledger = yield* AutomodeEpisodeLedger;

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
            const policy = snapshot.policy;

            // Fail closed: never land unverified work, and never land without a target.
            if (policy.integrationBranch === null) {
              yield* supervisor.haltDriver({
                reason: `Halted: ${running.title} finished but no integration branch is configured.`,
              });
              return;
            }
            if (policy.verificationCommands.length === 0) {
              yield* supervisor.haltDriver({
                reason: `Halted: ${running.title} finished but no verification commands are configured.`,
              });
              return;
            }
            if (peer.worktreePath === null || peer.branch === null) {
              yield* supervisor.haltDriver({
                reason: `Halted: peer ${peer.id} has no worktree/branch to verify and land.`,
              });
              return;
            }

            const review = yield* reviewPipeline
              .review({
                worktree: peer.worktreePath,
                baseRef: policy.integrationBranch,
                sliceId: running.id,
                verificationCommands: policy.verificationCommands,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AutomodeSupervisorError({
                      message: `Verifier failed for ${running.title}.`,
                      cause,
                    }),
                ),
              );

            const decision = decide_automode_gate(review);
            if (decision.action === "fail") {
              yield* supervisor.failGoal({ goalId: running.id, reason: decision.reason });
              yield* supervisor.haltDriver({
                reason: `Halted: ${running.title} failed review — ${decision.reason}`,
              });
              return;
            }

            const landResult = yield* landing.land_slice({
              repo: running.repo,
              integrationBranch: policy.integrationBranch,
              baseRef: "gits",
              sliceBranch: peer.branch,
            });
            if (landResult.status === "rejected") {
              yield* supervisor.haltDriver({
                reason: `Halted: ${running.title} passed review but could not land — ${landResult.reason}`,
              });
              return;
            }

            yield* supervisor.completeGoal({ goalId: running.id });

            // Record the episode (verifier output) for rehydrate. A ledger hiccup
            // must not halt the run — the slice already landed and the goal is done.
            const recordedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            yield* ledger
              .record_episode({
                id: `ep-${running.id}-${recordedAt}`,
                repo: running.repo,
                goalId: running.id,
                goalTitle: running.title,
                sliceBranch: peer.branch,
                verdict: review.semantic?.verdict ?? "uncertain",
                confidence: review.semantic?.confidence ?? null,
                recommendation: review.recommendation,
                flagged: decision.flagged,
                summary: review.summary,
                review,
                createdAt: recordedAt,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("gits.automode.ledger.record-failed", {
                    goalId: running.id,
                    error: error.message,
                  }),
                ),
              );
            yield* Effect.logInfo("gits.automode.driver.goal-landed", {
              goalId: running.id,
              peerId: peer.id,
              flagged: decision.flagged,
            });
            return;
          }
          return; // pending / running / blocked → still in flight
        }

        // 2) Idle: if halted, wait for an operator resume.
        if (snapshot.driverHalted) {
          return;
        }

        // 3) Queue drained → held-PR lifecycle, then dispatch.
        const next = oldestQueued(snapshot.goals);
        if (next === null) {
          // Run is terminal once the held PR merged.
          if (snapshot.runMerged) {
            return;
          }
          const policy = snapshot.policy;
          if (policy.integrationBranch === null) {
            return;
          }
          const landedRepo =
            snapshot.goals.find((goal) => goal.status === "completed")?.repo ?? null;

          if (snapshot.heldPrUrl === null || snapshot.heldPrNumber === null) {
            // Open the held PR exactly once, only if at least one slice landed.
            if (landedRepo === null) {
              return;
            }
            const landedTitles = snapshot.goals
              .filter((goal) => goal.status === "completed")
              .map((goal) => `- ${goal.title}`)
              .join("\n");
            const result = yield* heldPr.open_held_pr({
              repo: landedRepo,
              integrationBranch: policy.integrationBranch,
              baseBranch: "gits",
              title: `automode: held PR for ${policy.integrationBranch}`,
              body: `Autonomous run — landed slices (held for review, not auto-merged):\n\n${landedTitles}`,
            });
            if (result.status === "rejected") {
              yield* supervisor.haltDriver({
                reason: `Halted: could not open held PR — ${result.reason}`,
              });
              return;
            }
            yield* supervisor.recordHeldPr({ url: result.url, number: result.number });
            return;
          }

          // Held PR already open → poll GitHub for the merge.
          if (landedRepo === null) {
            return;
          }
          const detect = yield* heldPr.detect_merge({
            repo: landedRepo,
            prNumber: snapshot.heldPrNumber,
          });
          if (detect.merged) {
            yield* supervisor.markRunMerged();
            yield* Effect.logInfo("gits.automode.run-merged", { heldPrUrl: snapshot.heldPrUrl });
          }
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

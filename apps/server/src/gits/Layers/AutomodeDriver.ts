import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import {
  AutomodeSupervisorError,
  type AutomodeGoal,
  type AutomodeSnapshot,
  type GitsVerifyCommand,
  type PeerStatus,
} from "@t3tools/contracts";

import { DelamainAdapter } from "../Services/DelamainAdapter.ts";
import { AutomodeSupervisor } from "../Services/AutomodeSupervisor.ts";
import { AutomodeDriver, type AutomodeDriverShape } from "../Services/AutomodeDriver.ts";
import { AutomodeProposalSweep } from "../Services/AutomodeProposalSweep.ts";
import { AutomodeTelegramDigest } from "../Services/AutomodeTelegramDigest.ts";
import { GitsReviewPipeline } from "../Services/GitsReviewPipeline.ts";
import { GitsSlotScheduler } from "../Services/GitsSlotScheduler.ts";
import { AUTOMODE_BASE_REF, AutomodeLanding } from "../Services/AutomodeLanding.ts";
import { AutomodeHeldPr } from "../Services/AutomodeHeldPr.ts";
import { AutomodeEpisodeLedger } from "../../persistence/Services/AutomodeEpisodeLedger.ts";
import { decide_automode_gate } from "./AutomodeReviewGate.ts";
import { AutomodeNotifications } from "./AutomodeNotifications.ts";

export const HALT_ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** Pure gate for halt Telegram alerts: send unless the same reason fired within the cooldown. */
export function shouldSendHaltAlert(
  last: { readonly reason: string; readonly at: number } | null,
  reason: string,
  now: number,
): boolean {
  return last === null || last.reason !== reason || now - last.at >= HALT_ALERT_COOLDOWN_MS;
}

const TICK_INTERVAL_MS = (() => {
  const raw = process.env.GITS_AUTOMODE_DRIVER_TICK_MS?.trim();
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

// Verify floor (the #154 lesson): autonomous slices always run at least the CI-shaped
// checks, no matter how thin policy.verificationCommands is. Policy overrides a floor
// entry by label via the existing updatePolicy RPC — no env escape hatch needed.
// ponytail: gitscode-specific commands until the phase-3 repo registry owns per-repo floors.
export const AUTOMODE_VERIFY_FLOOR: ReadonlyArray<GitsVerifyCommand> = [
  { label: "fmt", cmd: ["bun", "run", "fmt:check"] },
  { label: "lint", cmd: ["bun", "run", "lint"] },
  { label: "typecheck", cmd: ["bun", "run", "typecheck"] },
  { label: "test", cmd: ["bun", "run", "test"], timeoutSeconds: 900 },
  { label: "build", cmd: ["bun", "run", "build"], timeoutSeconds: 900 },
];

/** Floor ∪ policy commands, merged by label — a policy entry wins on collision. */
export function merge_verify_commands(
  policyCommands: ReadonlyArray<GitsVerifyCommand>,
): GitsVerifyCommand[] {
  const byLabel = new Map(AUTOMODE_VERIFY_FLOOR.map((command) => [command.label, command]));
  for (const command of policyCommands) {
    byLabel.set(command.label, command);
  }
  return [...byLabel.values()];
}

const TERMINAL_FAIL_STATUSES = new Set<PeerStatus>(["failed", "frozen", "killed", "halted"]);
const TERMINAL_DONE_STATUSES = new Set<PeerStatus>(["done", "completed"]);

function oldestQueued(goals: ReadonlyArray<AutomodeGoal>): AutomodeGoal | null {
  // The snapshot sorts goals newest-first; reverse before sorting so that
  // equal-timestamp goals remain in oldest-first (FIFO) order.
  const queued = goals
    .toReversed()
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
    const scheduler = yield* GitsSlotScheduler;
    const telegramDigest = yield* AutomodeTelegramDigest;
    const proposalSweep = yield* AutomodeProposalSweep;
    const notifications = yield* AutomodeNotifications;

    const toDriverError = (message: string) => (cause: unknown) =>
      new AutomodeSupervisorError({ message, cause });

    const notify = (input: {
      readonly subject: string;
      readonly title: string;
      readonly goalId: string | null;
      readonly reason: string;
      readonly prUrl?: string | null;
    }) =>
      Effect.gen(function* () {
        const policy = yield* supervisor.getPolicy();
        yield* notifications
          .notify({
            key: `automode:${input.goalId ?? "driver"}:${input.subject}`,
            subject: input.subject,
            text: [
              `Title: ${input.title}`,
              `Goal ID: ${input.goalId ?? "none"}`,
              `Reason: ${input.reason}`,
              ...(input.prUrl === undefined || input.prUrl === null
                ? []
                : [`PR URL: ${input.prUrl}`]),
            ].join("\n"),
            url: `/gits?panel=autopilot${input.goalId === null ? "" : `&goal=${encodeURIComponent(input.goalId)}`}`,
            gitsEnabled: policy.gitsNotificationsEnabled,
            telegramEnabled: policy.telegramNotificationsEnabled,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("gits.automode.notification-failed", { cause }),
            ),
          );
      });

    const failGoal = (goal: AutomodeGoal, reason: string) =>
      supervisor.failGoal({ goalId: goal.id, reason }).pipe(
        Effect.tap(() =>
          notify({
            subject: "GITS automode goal failed",
            title: goal.title,
            goalId: goal.id,
            reason,
          }),
        ),
      );

    // Same-reason halt alerts are suppressed for a cooldown window: a driver that
    // re-halts into the same failure (e.g. operator keeps resuming, or a gate keeps
    // denying) must not flood Telegram with identical messages.
    // ponytail: in-memory, resets on restart — acceptable, restarts re-arm the kill switch.
    const lastHaltAlertRef = yield* Ref.make<{ reason: string; at: number } | null>(null);
    const halt = (goal: AutomodeGoal | null, reason: string) =>
      supervisor.haltDriver({ reason }).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const last = yield* Ref.get(lastHaltAlertRef);
            if (!shouldSendHaltAlert(last, reason, now)) {
              return yield* Effect.logInfo("gits.automode.halt-alert-suppressed", { reason });
            }
            yield* Ref.set(lastHaltAlertRef, { reason, at: now });
            yield* notify({
              subject: "GITS automode halted",
              title: goal?.title ?? "Automode driver",
              goalId: goal?.id ?? null,
              reason,
            });
          }),
        ),
      );

    // Held-PR lifecycle: open exactly once after ≥1 landed slice, then poll for the merge.
    // Runs on queue-drained ticks AND gate-denied ticks — a night-capped run (goals still
    // queued, gate denying) must not starve its held PR. Self-guards on runMerged /
    // integration branch / landed repo.
    const maintainHeldPr = (snapshot: AutomodeSnapshot) =>
      Effect.gen(function* () {
        // Run is terminal once the held PR merged.
        if (snapshot.runMerged) {
          return;
        }
        const policy = snapshot.policy;
        if (policy.integrationBranch === null) {
          return;
        }
        const landedRepo = snapshot.goals.find((goal) => goal.status === "completed")?.repo ?? null;
        if (landedRepo === null) {
          return;
        }

        if (snapshot.heldPrUrl === null || snapshot.heldPrNumber === null) {
          // Open the held PR exactly once, only if at least one slice landed.
          const landedTitles = snapshot.goals
            .filter((goal) => goal.status === "completed")
            .map((goal) => `- ${goal.title} (episode ${goal.episodeId})`)
            .join("\n");
          const result = yield* heldPr.open_held_pr({
            repo: landedRepo,
            integrationBranch: policy.integrationBranch,
            baseBranch: AUTOMODE_BASE_REF,
            title: `automode: held PR for ${policy.integrationBranch}`,
            body: `Autonomous run — landed slices (held for review, not auto-merged):\n\n${landedTitles}`,
          });
          if (result.status === "rejected") {
            yield* halt(null, `Halted: could not open held PR — ${result.reason}`);
            return;
          }
          yield* supervisor.recordHeldPr({ url: result.url, number: result.number });
          yield* notify({
            subject: "GITS automode held PR created",
            title: `automode: held PR for ${policy.integrationBranch}`,
            goalId: snapshot.goals.find((goal) => goal.status === "completed")?.id ?? null,
            reason: "Landed slices are held for human review.",
            prUrl: result.url,
          });
          return;
        }

        // Held PR already open → poll GitHub for the merge.
        const detect = yield* heldPr.detect_merge({
          repo: landedRepo,
          prNumber: snapshot.heldPrNumber,
        });
        if (detect.merged) {
          yield* supervisor.markRunMerged();
          yield* Effect.logInfo("gits.automode.run-merged", { heldPrUrl: snapshot.heldPrUrl });
        }
      });

    const tickOnce: AutomodeDriverShape["tickOnce"] = () =>
      Effect.gen(function* () {
        // Gate first on the cheap policy read (stateRef only). When automode is off
        // — the steady state — this skips the full getSnapshot (peer-list subprocess +
        // budget read) that used to run on every 5 s tick.
        const policy = yield* supervisor.getPolicy();
        if (policy.mode !== "autonomous" || policy.killSwitchEnabled) {
          return;
        }

        const snapshot = yield* supervisor.getSnapshot();

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
            yield* halt(
              running,
              `Halted: peer ${running.peerId} for "${running.title}" not found in delamain (vanished or reaped) — manual check needed.`,
            );
            return;
          }

          if (peer.integrationStatus === "failed" || TERMINAL_FAIL_STATUSES.has(peer.status)) {
            yield* failGoal(running, `Peer ${peer.id} ended as ${peer.status}.`);
            yield* halt(running, `Halted: ${running.title} failed (${peer.status}).`);
            return;
          }
          if (peer.integrationStatus === "skipped") {
            // delamain skips the push when the peer branch has zero commits ahead of the
            // sync base — nothing ever reaches origin, so landing would fail every tick.
            yield* failGoal(
              running,
              `Peer ${peer.id} finished with no changes ahead of the integration branch (nothing pushed).`,
            );
            yield* halt(running, `Halted: ${running.title} produced no changes to land.`);
            return;
          }
          if (peer.status === "waiting") {
            yield* notify({
              subject: "GITS automode goal waiting",
              title: running.title,
              goalId: running.id,
              reason: `Peer ${peer.id} is waiting on input.`,
            });
            yield* halt(
              running,
              `Halted: peer ${peer.id} is waiting on input for ${running.title}.`,
            );
            return;
          }
          if (TERMINAL_DONE_STATUSES.has(peer.status)) {
            const policy = snapshot.policy;

            // Fail closed: never land unverified work, and never land without a target.
            // The branch is minted at dispatch; the policy fallback covers goals
            // dispatched before per-goal branches existed.
            const goalBranch = running.branch ?? policy.integrationBranch;
            if (goalBranch === null) {
              yield* halt(
                running,
                `Halted: ${running.title} finished but has no branch to land on.`,
              );
              return;
            }
            // Floor ∪ policy (policy wins by label). The fail-closed empty check guards
            // the MERGED set — unreachable while the floor const is non-empty, kept as
            // defense against a future emptied floor.
            const verificationCommands = merge_verify_commands(
              running.verificationCommands.length > 0
                ? running.verificationCommands
                : policy.verificationCommands,
            );
            if (verificationCommands.length === 0) {
              yield* halt(
                running,
                `Halted: ${running.title} finished but no verification commands are configured.`,
              );
              return;
            }
            // The work lands on the LEAF peer's branch, not the workflow run record's.
            // For a workflow-dispatched goal, resolve the leaf via workflowStatus
            // (agentPeerIds); the peer we reconciled on is the run record itself.
            // ponytail: v1 lands exactly one leaf — multiple leaves land the first and warn;
            // upgrade to fan-in landing when a goal-workflow spawns >1 producing leaf.
            let slicePeer = peer;
            if (running.workflowId !== null) {
              const statusResult = yield* delamainAdapter
                .workflowStatus({ workflowId: running.workflowId })
                .pipe(Effect.result);
              if (Result.isFailure(statusResult)) {
                yield* failGoal(
                  running,
                  `Could not read workflow ${running.workflowId} status to resolve the landed slice.`,
                );
                yield* halt(
                  running,
                  `Halted: workflow ${running.workflowId} status read failed for ${running.title}.`,
                );
                return;
              }
              const leafIds = statusResult.success.peerIds;
              if (leafIds.length === 0) {
                yield* failGoal(
                  running,
                  `Workflow ${running.workflowId} finished with no leaf peer to land.`,
                );
                yield* halt(
                  running,
                  `Halted: workflow ${running.workflowId} produced no leaf peer for ${running.title}.`,
                );
                return;
              }
              if (leafIds.length > 1) {
                yield* Effect.logWarning("gits.automode.driver.workflow-multiple-leaves", {
                  goalId: running.id,
                  workflowId: running.workflowId,
                  leafIds,
                });
              }
              const leafResult = yield* delamainAdapter
                .getPeerStatus({ peerId: leafIds[0]! })
                .pipe(Effect.result);
              if (Result.isFailure(leafResult)) {
                yield* failGoal(
                  running,
                  `Could not read leaf peer ${leafIds[0]} of workflow ${running.workflowId}.`,
                );
                yield* halt(
                  running,
                  `Halted: leaf peer ${leafIds[0]} status read failed for ${running.title}.`,
                );
                return;
              }
              slicePeer = leafResult.success;
            }

            if (slicePeer.worktreePath === null || slicePeer.branch === null) {
              yield* halt(
                running,
                `Halted: peer ${slicePeer.id} has no worktree/branch to verify and land.`,
              );
              return;
            }

            // Fail closed: a verifier that errors (not a fail verdict) must halt,
            // not leave the goal running and retry the pipeline every tick.
            const reviewResult = yield* reviewPipeline
              .review({
                worktree: slicePeer.worktreePath,
                baseRef: goalBranch,
                sliceId: running.id,
                verificationCommands,
              })
              .pipe(Effect.result);
            if (Result.isFailure(reviewResult)) {
              yield* failGoal(running, `Verifier errored for ${running.title}.`);
              yield* halt(
                running,
                `Halted: verifier errored for ${running.title} — manual check needed.`,
              );
              return;
            }

            const review = reviewResult.success;
            const decision = decide_automode_gate(review);
            if (decision.action === "fail") {
              yield* failGoal(running, decision.reason);
              yield* halt(running, `Halted: ${running.title} failed review — ${decision.reason}`);
              return;
            }

            const landResult = yield* landing.land_slice({
              repo: running.repo,
              integrationBranch: goalBranch,
              baseRef: AUTOMODE_BASE_REF,
              sliceBranch: slicePeer.branch,
            });
            if (landResult.status === "rejected") {
              yield* halt(
                running,
                `Halted: ${running.title} passed review but could not land — ${landResult.reason}`,
              );
              return;
            }

            yield* supervisor.completeGoal({ goalId: running.id });

            // Record the episode (verifier output) for rehydrate. A ledger hiccup
            // must not halt the run — the slice already landed and the goal is done.
            const recordedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            yield* ledger
              .record_episode({
                id: `ep-${running.id}-${recordedAt}`,
                episodeId: running.episodeId,
                repo: running.repo,
                goalId: running.id,
                goalTitle: running.title,
                sliceBranch: slicePeer.branch,
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

            // Goals landed on their own branch (not the run's shared integration branch —
            // compare against the CURRENT policy so a mid-run integrationBranch change
            // cannot strand the landed work) get a held PR each, opened right here — the
            // run-level held-PR lifecycle below only serves shared-branch runs. Fail
            // closed on BOTH channels: gh failures (auth, network, non-zero exit) arrive
            // as Effect errors, not "rejected" values, and must halt just as loudly.
            // ponytail: edge-triggered — a process death between the completeGoal commit
            // and the PR open loses the PR silently (GitHub's PR list is the durable
            // surface); upgrade to a maintainHeldPr-style per-goal reconcile if it bites.
            if (goalBranch !== policy.integrationBranch) {
              const prResult = yield* heldPr
                .open_held_pr({
                  repo: running.repo,
                  integrationBranch: goalBranch,
                  baseBranch: AUTOMODE_BASE_REF,
                  title: `automode: ${running.title}`,
                  body: `Autonomous slice (held for review, not auto-merged):\n\n- ${running.title} (episode ${running.episodeId})`,
                })
                .pipe(Effect.result);
              if (Result.isFailure(prResult)) {
                yield* halt(
                  running,
                  `Halted: ${running.title} landed but the held PR open errored — ${prResult.failure.message}`,
                );
                return;
              }
              if (prResult.success.status === "rejected") {
                yield* halt(
                  running,
                  `Halted: ${running.title} landed but could not open held PR — ${prResult.success.reason}`,
                );
                return;
              }
              yield* notify({
                subject: "GITS automode goal landed",
                title: running.title,
                goalId: running.id,
                reason: "Landed on its own branch; the held PR awaits review.",
                prUrl: prResult.success.url,
              });
            }
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

        // 3) Queue drained → held-PR lifecycle only.
        const next = oldestQueued(snapshot.goals);
        if (next === null) {
          yield* maintainHeldPr(snapshot);
          return;
        }
        if (
          next.notBefore !== null &&
          Date.parse(next.notBefore) > (yield* Clock.currentTimeMillis)
        ) {
          yield* maintainHeldPr(snapshot);
          return;
        }
        // Scheduler start gate (decisions 6/7/11/20): a deny leaves the goal queued for a
        // later tick — quiet, NOT a halt. Manual RPC dispatch stays ungated (human-driven).
        const gate = yield* scheduler
          .checkStartAllowed({
            expectedRuntimeMinutes: next.maxRuntimeMinutes ?? snapshot.policy.maxRuntimeMinutes,
            maxActivePeers: snapshot.policy.maxActivePeers,
          })
          .pipe(Effect.mapError(toDriverError("Scheduler start gate check failed.")));
        if (!gate.allowed) {
          // A denied night still maintains the held PR for already-landed slices —
          // otherwise a night-capped run would never open/poll it while goals stay queued.
          yield* maintainHeldPr(snapshot);
          return;
        }
        // Disabled-scheduler bypass: a supervised daytime dispatch must not consume the night cap.
        if (gate.bypassed !== true) {
          const recorded = yield* scheduler
            .recordGoalStart({ goalId: next.id, episodeId: next.episodeId })
            .pipe(
              Effect.as(true),
              // Fail closed: an unrecorded start would undercount the decision-11 night cap.
              Effect.catch((error) =>
                halt(
                  next,
                  `Halted: scheduler failed to record the start of ${next.title} — ${error.message}`,
                ).pipe(Effect.as(false)),
              ),
            );
          if (!recorded) {
            return;
          }
        }
        // Fail closed: a dispatch that ERRORS (ensure/spawn) must halt, not fall through
        // to the tick-level catch and retry every 5 s — each silent retry would burn a
        // scheduler night-cap slot until the whole night is consumed.
        const dispatched = yield* supervisor.dispatchGoal({ goalId: next.id }).pipe(Effect.result);
        if (Result.isFailure(dispatched)) {
          yield* halt(
            next,
            `Halted: dispatch of ${next.title} errored — ${dispatched.failure.message}`,
          );
          return;
        }
        const result = dispatched.success;
        if (result.peer === null) {
          yield* notify({
            subject: result.approvalRequired
              ? "GITS automode goal waiting"
              : "GITS automode goal blocked",
            title: next.title,
            goalId: next.id,
            reason: result.blockedReason ?? "Automode dispatch did not start.",
          });
          yield* halt(
            next,
            result.blockedReason ?? `Dispatch of ${next.title} did not spawn a peer.`,
          );
        }
      }).pipe(Effect.ensuring(proposalSweep.tick()), Effect.ensuring(telegramDigest.tick()));

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

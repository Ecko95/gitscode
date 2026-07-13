import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutomodeSupervisorError } from "@t3tools/contracts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { AutomodeLanding, type AutomodeLandingShape } from "../Services/AutomodeLanding.ts";
import {
  build_ensure_integration_branch_commands,
  build_land_slice_commands,
  type AutomodeGitArgv,
} from "./AutomodeLandingCommands.ts";

export const AutomodeLandingLive = Layer.effect(
  AutomodeLanding,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver;

    // Run a command that must succeed; a non-zero exit / spawn failure becomes an error.
    const run = (repo: string, command: AutomodeGitArgv) =>
      git.execute({ operation: command.operation, cwd: repo, args: [...command.args] }).pipe(
        Effect.mapError(
          (cause) =>
            new AutomodeSupervisorError({
              message: `git ${command.args.join(" ")} failed.`,
              cause,
            }),
        ),
      );

    // Ensure the integration branch exists on origin (create from baseRef if absent).
    // `--exit-code` makes ls-remote return 2 when the ref is missing; allow that as a value.
    const ensure_integration_branch: AutomodeLandingShape["ensure_integration_branch"] = (input) =>
      Effect.gen(function* () {
        const exists = yield* git
          .execute({
            operation: "automode-ls-integration",
            cwd: input.repo,
            args: ["ls-remote", "--exit-code", "origin", `refs/heads/${input.integrationBranch}`],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.mapError(
              (cause) => new AutomodeSupervisorError({ message: "git ls-remote failed.", cause }),
            ),
          );

        if (!exists) {
          for (const command of build_ensure_integration_branch_commands({
            integrationBranch: input.integrationBranch,
            baseRef: input.baseRef,
          })) {
            yield* run(input.repo, command);
          }
        }
      });

    const land_slice: AutomodeLandingShape["land_slice"] = (input) =>
      Effect.gen(function* () {
        // 1) Belt-and-braces: dispatch already ensures the branch, but an RPC dispatch
        //    could race a manual branch deletion, so ensure again at land time.
        yield* ensure_integration_branch({
          repo: input.repo,
          integrationBranch: input.integrationBranch,
          baseRef: input.baseRef,
        });

        // 2) Fast-forward the integration branch to the slice tip.
        const commands = build_land_slice_commands({
          sliceBranch: input.sliceBranch,
          integrationBranch: input.integrationBranch,
        });
        yield* run(input.repo, commands[0]!); // fetch slice — a real failure throws

        const push = yield* git
          .execute({
            operation: commands[1]!.operation,
            cwd: input.repo,
            args: [...commands[1]!.args],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.mapError(
              (cause) => new AutomodeSupervisorError({ message: "git push failed.", cause }),
            ),
          );

        if (push.exitCode !== 0) {
          return {
            status: "rejected" as const,
            reason: `Integration branch could not fast-forward to ${input.sliceBranch} (non-fast-forward). ${push.stderr.trim()}`,
          };
        }
        return { status: "landed" as const };
      });

    return { ensure_integration_branch, land_slice } satisfies AutomodeLandingShape;
  }),
);

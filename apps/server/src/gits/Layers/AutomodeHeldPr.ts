import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutomodeSupervisorError } from "@t3tools/contracts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import { AutomodeHeldPr, type AutomodeHeldPrShape } from "../Services/AutomodeHeldPr.ts";

export const AutomodeHeldPrLive = Layer.effect(
  AutomodeHeldPr,
  Effect.gen(function* () {
    const gh = yield* GitHubCli;

    const findForHead = (repo: string, head: string, base: string) =>
      gh.listOpenPullRequests({ cwd: repo, headSelector: head }).pipe(
        Effect.map((prs) => prs.find((candidate) => candidate.baseRefName === base) ?? null),
        Effect.mapError(
          (cause) => new AutomodeSupervisorError({ message: "gh pr list failed.", cause }),
        ),
      );

    const open_held_pr: AutomodeHeldPrShape["open_held_pr"] = (input) =>
      Effect.gen(function* () {
        // Idempotent: if a held PR for this head already exists, return it.
        const existing = yield* findForHead(input.repo, input.integrationBranch, input.baseBranch);
        if (existing !== null) {
          return { status: "opened" as const, url: existing.url, number: existing.number };
        }

        yield* gh
          .execute({
            cwd: input.repo,
            args: [
              "pr",
              "create",
              "--base",
              input.baseBranch,
              "--head",
              input.integrationBranch,
              "--title",
              input.title,
              "--body",
              input.body,
            ],
          })
          .pipe(
            Effect.mapError(
              (cause) => new AutomodeSupervisorError({ message: "gh pr create failed.", cause }),
            ),
          );

        const created = yield* findForHead(input.repo, input.integrationBranch, input.baseBranch);
        if (created === null) {
          return {
            status: "rejected" as const,
            reason: `Held PR for ${input.integrationBranch} could not be found after creation.`,
          };
        }
        return { status: "opened" as const, url: created.url, number: created.number };
      });

    const detect_merge: AutomodeHeldPrShape["detect_merge"] = (input) =>
      gh.getPullRequest({ cwd: input.repo, reference: String(input.prNumber) }).pipe(
        Effect.map((pr) => ({ merged: pr.state === "merged" })),
        Effect.mapError(
          (cause) => new AutomodeSupervisorError({ message: "gh pr view failed.", cause }),
        ),
      );

    return { open_held_pr, detect_merge } satisfies AutomodeHeldPrShape;
  }),
);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AutomodeSupervisorError } from "@t3tools/contracts";
import { GitHubCli } from "../../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { AutomodeHeldPr, type AutomodeHeldPrShape } from "../Services/AutomodeHeldPr.ts";

// `gh pr create` prints the created PR's URL on stdout (e.g.
// https://github.com/owner/repo/pull/154). Reading it back avoids a
// create-then-list race: gh's list/search index lags behind create, so a
// post-create `gh pr list` can falsely report the just-created PR as missing.
const CREATED_PR_URL_RE = /(https?:\/\/\S+\/pull\/(\d+))/;

function parseCreatedPr(stdout: string): { url: string; number: number } | null {
  const match = stdout.match(CREATED_PR_URL_RE);
  const url = match?.[1];
  const digits = match?.[2];
  if (url === undefined || digits === undefined) {
    return null;
  }
  const number = Number(digits);
  return Number.isSafeInteger(number) ? { url, number } : null;
}

// Pin gh to origin's owner/name so PR commands don't lean on gh's default-repo
// resolution, which picks the wrong remote on multi-remote / fork checkouts.
// Returns null for anything that isn't a recognizable GitHub http(s)/ssh remote
// (local paths, file:// URLs, malformed input) so callers degrade to gh's own
// resolution instead of passing a bogus --repo that makes gh hard-fail.
const SLUG_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function toSlug(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  const owner = segments[segments.length - 2];
  const rawName = segments[segments.length - 1];
  if (owner === undefined || rawName === undefined) {
    return null;
  }
  const name = rawName.replace(/\.git$/, "");
  return SLUG_SEGMENT_RE.test(owner) && SLUG_SEGMENT_RE.test(name) ? `${owner}/${name}` : null;
}

function parseOriginSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  // scp-like SSH: user@host:owner/repo(.git)
  const scpPath = trimmed.match(/^[^/@]+@[^:]+:(.+)$/)?.[1];
  if (scpPath !== undefined) {
    return toSlug(scpPath);
  }
  // URL form (https://, ssh://, git://): needs a real host and an owner/repo path.
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "file:" || parsed.host.length === 0 ? null : toSlug(parsed.pathname);
  } catch {
    return null;
  }
}

export const AutomodeHeldPrLive = Layer.effect(
  AutomodeHeldPr,
  Effect.gen(function* () {
    const gh = yield* GitHubCli;
    const process = yield* VcsProcess.VcsProcess;

    // Best-effort: on failure, degrade to gh's own resolution (correct on
    // single-remote clones) rather than hard-failing the run.
    const resolveOriginSlug = (repo: string) =>
      process
        .run({
          operation: "AutomodeHeldPr.originSlug",
          command: "git",
          args: ["remote", "get-url", "origin"],
          cwd: repo,
        })
        .pipe(
          Effect.map((output) => parseOriginSlug(output.stdout)),
          Effect.catch(() => Effect.succeed(null)),
        );

    const findForHead = (repo: string, head: string, base: string, slug: string | null) =>
      gh
        .listOpenPullRequests({ cwd: repo, headSelector: head, ...(slug ? { repo: slug } : {}) })
        .pipe(
          Effect.map((prs) => prs.find((candidate) => candidate.baseRefName === base) ?? null),
          Effect.mapError(
            (cause) => new AutomodeSupervisorError({ message: "gh pr list failed.", cause }),
          ),
        );

    const open_held_pr: AutomodeHeldPrShape["open_held_pr"] = (input) =>
      Effect.gen(function* () {
        const slug = yield* resolveOriginSlug(input.repo);

        // Idempotent: if a held PR for this head already exists, return it.
        const existing = yield* findForHead(
          input.repo,
          input.integrationBranch,
          input.baseBranch,
          slug,
        );
        if (existing !== null) {
          return { status: "opened" as const, url: existing.url, number: existing.number };
        }

        const createOutput = yield* gh
          .execute({
            cwd: input.repo,
            args: [
              "pr",
              "create",
              ...(slug ? ["--repo", slug] : []),
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

        // Prefer the URL gh prints on stdout — no post-create list, no race.
        const created = parseCreatedPr(createOutput.stdout);
        if (created !== null) {
          return { status: "opened" as const, url: created.url, number: created.number };
        }

        // Fallback only when stdout had no parseable PR URL (e.g. a warning-only line).
        const found = yield* findForHead(
          input.repo,
          input.integrationBranch,
          input.baseBranch,
          slug,
        );
        if (found === null) {
          return {
            status: "rejected" as const,
            reason: `Held PR for ${input.integrationBranch} could not be found after creation.`,
          };
        }
        return { status: "opened" as const, url: found.url, number: found.number };
      });

    const detect_merge: AutomodeHeldPrShape["detect_merge"] = (input) =>
      Effect.gen(function* () {
        const slug = yield* resolveOriginSlug(input.repo);
        return yield* gh
          .getPullRequest({
            cwd: input.repo,
            reference: String(input.prNumber),
            ...(slug ? { repo: slug } : {}),
          })
          .pipe(
            Effect.map((pr) => ({ merged: pr.state === "merged" })),
            Effect.mapError(
              (cause) => new AutomodeSupervisorError({ message: "gh pr view failed.", cause }),
            ),
          );
      });

    return { open_held_pr, detect_merge } satisfies AutomodeHeldPrShape;
  }),
);

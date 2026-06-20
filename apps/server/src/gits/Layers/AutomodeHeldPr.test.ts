import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitHubCli, type GitHubPullRequestSummary } from "../../sourceControl/GitHubCli.ts";
import { AutomodeHeldPr } from "../Services/AutomodeHeldPr.ts";
import { AutomodeHeldPrLive } from "./AutomodeHeldPr.ts";

const pr: GitHubPullRequestSummary = {
  number: 30,
  title: "t",
  url: "https://github.com/o/r/pull/30",
  baseRefName: "gits",
  headRefName: "auto/gits-self",
  state: "open",
};

function gh(overrides: {
  list?: ReadonlyArray<GitHubPullRequestSummary>;
  created?: ReadonlyArray<GitHubPullRequestSummary>;
  get?: GitHubPullRequestSummary;
}) {
  let createCalls = 0;
  return Layer.mock(GitHubCli)({
    execute: () =>
      Effect.sync(() => {
        createCalls += 1;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        } as never;
      }),
    listOpenPullRequests: () =>
      Effect.succeed(createCalls === 0 ? (overrides.list ?? []) : (overrides.created ?? [])),
    getPullRequest: () => Effect.succeed(overrides.get ?? { ...pr }),
  });
}

const openInput = {
  repo: "/tmp/repo",
  integrationBranch: "auto/gits-self",
  baseBranch: "gits",
  title: "automode held PR",
  body: "landed slices",
};

describe("AutomodeHeldPrLive", () => {
  it.effect("returns the existing open PR without creating a duplicate", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
      if (result.status === "opened") {
        assert.equal(result.number, 30);
      }
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ list: [pr] }))))),
  );

  it.effect("creates then looks up the PR when none exists yet", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
    }).pipe(
      Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ list: [], created: [pr] })))),
    ),
  );

  it.effect("rejects when the PR still cannot be found after create", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "rejected");
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ list: [], created: [] }))))),
  );

  it.effect("detect_merge true when PR state is merged", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 30 });
      assert.equal(result.merged, true);
    }).pipe(
      Effect.provide(
        AutomodeHeldPrLive.pipe(Layer.provide(gh({ get: { ...pr, state: "merged" } }))),
      ),
    ),
  );

  it.effect("detect_merge false when PR state is open", () =>
    Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 30 });
      assert.equal(result.merged, false);
    }).pipe(
      Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(gh({ get: { ...pr, state: "open" } })))),
    ),
  );
});

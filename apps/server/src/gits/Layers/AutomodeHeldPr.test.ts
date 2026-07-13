import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitHubCli, type GitHubPullRequestSummary } from "../../sourceControl/GitHubCli.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
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

function makeGh(overrides: {
  list?: ReadonlyArray<GitHubPullRequestSummary>;
  listAfter?: ReadonlyArray<GitHubPullRequestSummary>;
  createStdout?: string;
  get?: GitHubPullRequestSummary;
}) {
  const calls = {
    listCount: 0,
    createArgs: [] as ReadonlyArray<string>,
    listRepos: [] as Array<string | undefined>,
    getRepos: [] as Array<string | undefined>,
  };
  const layer = Layer.mock(GitHubCli)({
    execute: (input) =>
      Effect.sync(() => {
        calls.createArgs = input.args;
        return {
          stdout: overrides.createStdout ?? "",
          stderr: "",
          exitCode: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        } as never;
      }),
    listOpenPullRequests: (input) =>
      Effect.sync(() => {
        calls.listRepos.push(input.repo);
        const result = calls.listCount === 0 ? (overrides.list ?? []) : (overrides.listAfter ?? []);
        calls.listCount += 1;
        return result;
      }),
    getPullRequest: (input) =>
      Effect.sync(() => {
        calls.getRepos.push(input.repo);
        return overrides.get ?? { ...pr };
      }),
  });
  return { layer, calls };
}

function vcs(remoteUrl = "git@github.com:o/r.git") {
  return Layer.mock(VcsProcess.VcsProcess)({
    run: () =>
      Effect.succeed({
        stdout: remoteUrl,
        stderr: "",
        exitCode: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      } as never),
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
  it.effect("returns the existing open PR without creating a duplicate", () => {
    const g = makeGh({ list: [pr] });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
      if (result.status === "opened") {
        assert.equal(result.number, 30);
      }
      // Pre-check hit → create is never invoked.
      assert.deepEqual(g.calls.createArgs, []);
      assert.equal(g.calls.listCount, 1);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });

  it.effect("parses opened{url,number} from create stdout without a post-create list", () => {
    const g = makeGh({ list: [], createStdout: "https://github.com/o/r/pull/154\n" });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
      if (result.status === "opened") {
        assert.equal(result.number, 154);
        assert.equal(result.url, "https://github.com/o/r/pull/154");
      }
      // Only the pre-check listed; no post-create list call.
      assert.equal(g.calls.listCount, 1);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });

  it.effect("falls back to findForHead when create stdout has no PR url", () => {
    const g = makeGh({ list: [], listAfter: [pr], createStdout: "" });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "opened");
      if (result.status === "opened") {
        assert.equal(result.number, 30);
      }
      // Pre-check + post-create fallback = two list calls.
      assert.equal(g.calls.listCount, 2);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });

  it.effect("rejects when the PR still cannot be found after create", () => {
    const g = makeGh({ list: [], listAfter: [], createStdout: "" });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.open_held_pr(openInput);
      assert.equal(result.status, "rejected");
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });

  it.effect("pins --repo (origin slug) on create, list and view", () => {
    const g = makeGh({ list: [], createStdout: "https://github.com/o/r/pull/154\n" });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      yield* held.open_held_pr(openInput);
      yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 154 });

      // create: --repo o/r present in the gh args.
      const createArgs = g.calls.createArgs;
      const repoFlag = createArgs.indexOf("--repo");
      assert.notEqual(repoFlag, -1);
      assert.equal(createArgs[repoFlag + 1], "o/r");
      // list (pre-check) and view (detect_merge) both threaded the slug.
      assert.deepEqual(g.calls.listRepos, ["o/r"]);
      assert.deepEqual(g.calls.getRepos, ["o/r"]);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });

  it.effect("degrades to gh default resolution for a non-GitHub origin (no --repo)", () => {
    const g = makeGh({ list: [], createStdout: "https://github.com/o/r/pull/154\n" });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      yield* held.open_held_pr(openInput);
      // A local/file origin yields no parseable slug → gh args carry no --repo.
      assert.equal(g.calls.createArgs.includes("--repo"), false);
      assert.deepEqual(g.calls.listRepos, [undefined]);
    }).pipe(
      Effect.provide(
        AutomodeHeldPrLive.pipe(
          Layer.provide(Layer.mergeAll(g.layer, vcs("file:///srv/git/repo.git"))),
        ),
      ),
    );
  });

  it.effect("detect_merge true when PR state is merged", () => {
    const g = makeGh({ get: { ...pr, state: "merged" } });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 30 });
      assert.equal(result.merged, true);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });

  it.effect("detect_merge false when PR state is open", () => {
    const g = makeGh({ get: { ...pr, state: "open" } });
    return Effect.gen(function* () {
      const held = yield* AutomodeHeldPr;
      const result = yield* held.detect_merge({ repo: "/tmp/repo", prNumber: 30 });
      assert.equal(result.merged, false);
    }).pipe(Effect.provide(AutomodeHeldPrLive.pipe(Layer.provide(Layer.mergeAll(g.layer, vcs())))));
  });
});

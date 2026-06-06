// gits-verify CLI — runs the semantic verifier-critic (GitsSemanticVerifier) for one peer/slice
// and exits 0 (auto-merge) / 2 (hold-for-review) / 70 (usage or verifier error). This is the
// entrypoint the delamain-autopilot supervisor shells to after its mechanical gates pass green.
//
//   bun apps/server/src/gits/bin/verify.ts \
//     --worktree <dir> --base-ref origin/main \
//     [--criteria-file <slice.md> | --criterion "..." ...] [--slice-title T] [--model gpt-5.4-mini]
//
// Output: the GitsSemanticVerifyResult as JSON on stdout. Reads criteria from a per-slice markdown
// file (parseSliceCriteria) or inline --criterion flags; none → derived → hold (conservative).
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { GitsCodexVerifierAdapterLive } from "../Layers/GitsCodexVerifierAdapter.ts";
import { parseSliceCriteria } from "../Layers/GitsSliceCriteria.ts";
import { GitsSemanticVerifier } from "../Services/GitsSemanticVerifier.ts";

interface CliArgs {
  readonly worktree: string;
  readonly baseRef: string;
  readonly sliceId: string;
  readonly criteriaFile: string | null;
  readonly criteria: ReadonlyArray<string>;
  readonly sliceTitle: string | null;
  readonly model: string | null;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let worktree = "";
  let baseRef = "";
  let sliceId = "slice";
  let criteriaFile: string | null = null;
  let sliceTitle: string | null = null;
  let model: string | null = null;
  const criteria: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--worktree") worktree = next();
    else if (a === "--base-ref") baseRef = next();
    else if (a === "--slice-id") sliceId = next();
    else if (a === "--criteria-file") criteriaFile = next();
    else if (a === "--criterion") criteria.push(next());
    else if (a === "--slice-title") sliceTitle = next();
    else if (a === "--model") model = next();
  }
  return { worktree, baseRef, sliceId, criteriaFile, criteria, sliceTitle, model };
}

const program = Effect.gen(function* () {
  const args = parseArgs(process.argv.slice(2));
  if (args.worktree === "" || args.baseRef === "") {
    yield* Effect.sync(() =>
      process.stderr.write(
        "usage: verify --worktree <dir> --base-ref <ref> [--criteria-file f | --criterion c ...]\n",
      ),
    );
    return 70;
  }

  let acceptanceCriteria: ReadonlyArray<string> = args.criteria;
  let sliceTitle = args.sliceTitle;
  if (args.criteriaFile !== null) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(args.criteriaFile).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const md = yield* fs.readFileString(args.criteriaFile);
      const parsed = parseSliceCriteria(args.sliceId, md);
      acceptanceCriteria = parsed.acceptanceCriteria;
      sliceTitle = parsed.title;
    }
  }

  const verifier = yield* GitsSemanticVerifier;
  const result = yield* verifier.verify({
    worktree: args.worktree,
    baseRef: args.baseRef,
    acceptanceCriteria,
    sliceTitle,
    ...(args.model !== null ? { model: args.model } : {}),
  });

  yield* Effect.sync(() =>
    process.stdout.write(
      `${[
        `verdict=${result.verdict}`,
        `confidence=${result.confidence}`,
        `recommendation=${result.recommendation}`,
        `criteriaProvided=${result.criteriaProvided}`,
        `model=${result.model}`,
        result.missed.length > 0 ? `missed=${result.missed.join(" | ")}` : "",
        result.reasons.length > 0 ? `reasons=${result.reasons.join(" | ")}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("\n")}\n`,
    ),
  );
  return result.recommendation === "auto-merge" ? 0 : 2;
});

const runtime = GitsCodexVerifierAdapterLive.pipe(Layer.provideMerge(NodeServices.layer));

Effect.runPromise(program.pipe(Effect.provide(runtime))).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `gits-verify error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(70);
  },
);

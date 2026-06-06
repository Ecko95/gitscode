import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  GitsSliceCriteriaError,
  type GitsSliceCriteria,
  type GitsSliceCriteriaSaveInput,
} from "@t3tools/contracts";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerConfig } from "../../config.ts";
import {
  GitsSliceCriteriaStore,
  type GitsSliceCriteriaStoreShape,
} from "../Services/GitsSliceCriteriaStore.ts";

const SLICES_DIR = "slices";

function toError(message: string, cause?: unknown) {
  return new GitsSliceCriteriaError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Parse a slice-criteria markdown file. Title = first `# ` line; criteria = `- `/`* ` bullets
 * under an `## Acceptance Criteria` heading. No bullets → empty + source "derived".
 */
export function parseSliceCriteria(sliceId: string, markdown: string): GitsSliceCriteria {
  const lines = markdown.split(/\r?\n/);
  let title: string | null = null;
  const criteria: string[] = [];
  let inCriteria = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (title === null && line.startsWith("# ")) {
      title = line.slice(2).trim() || null;
      continue;
    }
    if (line.startsWith("## ")) {
      inCriteria = /acceptance criteria/i.test(line.slice(3));
      continue;
    }
    if (inCriteria && (line.startsWith("- ") || line.startsWith("* "))) {
      const item = line.slice(2).trim();
      if (item.length > 0) criteria.push(item);
    }
  }
  return {
    sliceId,
    title,
    acceptanceCriteria: criteria,
    source: criteria.length > 0 ? "authored" : "derived",
  };
}

/** Render a slice-criteria markdown file from criteria. */
export function renderSliceCriteria(input: {
  readonly sliceId: string;
  readonly title?: string | null | undefined;
  readonly acceptanceCriteria: ReadonlyArray<string>;
}): string {
  const heading = (input.title ?? input.sliceId).trim();
  const body =
    input.acceptanceCriteria.length > 0
      ? input.acceptanceCriteria.map((c) => `- ${c.trim()}`).join("\n")
      : "(no acceptance criteria yet — verifier will derive provisional ones)";
  return `# ${heading}\n\n## Acceptance Criteria\n\n${body}\n`;
}

export const GitsSliceCriteriaStoreLive = Layer.effect(
  GitsSliceCriteriaStore,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const config = yield* ServerConfig;

    const slicePath = (sliceId: string) =>
      pathService.join(config.stateDir, "gits", SLICES_DIR, `${sliceId}.md`);

    const load: GitsSliceCriteriaStoreShape["load"] = (input) =>
      Effect.gen(function* () {
        const file = slicePath(input.sliceId);
        const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          return {
            sliceId: input.sliceId,
            title: null,
            acceptanceCriteria: [],
            source: "derived",
          } satisfies GitsSliceCriteria;
        }
        const raw = yield* fs
          .readFileString(file)
          .pipe(
            Effect.mapError((cause) =>
              toError(`Failed to read slice criteria for ${input.sliceId}.`, cause),
            ),
          );
        return parseSliceCriteria(input.sliceId, raw);
      });

    const save: GitsSliceCriteriaStoreShape["save"] = (input: GitsSliceCriteriaSaveInput) =>
      Effect.gen(function* () {
        const dir = pathService.join(config.stateDir, "gits", SLICES_DIR);
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError((cause) => toError("Failed to create slices directory.", cause)));
        const contents = renderSliceCriteria(input);
        yield* writeFileStringAtomically({ filePath: slicePath(input.sliceId), contents }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, pathService),
          Effect.mapError((cause) =>
            toError(`Failed to write slice criteria for ${input.sliceId}.`, cause),
          ),
        );
        return parseSliceCriteria(input.sliceId, contents);
      });

    return { load, save } satisfies GitsSliceCriteriaStoreShape;
  }),
);

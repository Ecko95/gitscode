import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { assert, it } from "@effect/vitest";

import * as CodexSchema from "./schema.ts";

// Regression: rust-v0.144.1 opened up ReasoningEffort to an arbitrary non-empty string
// (accounts now report efforts like "max"/"ultra"). Before the schema regen this was a
// 6-value literal union, so model/list responses reporting these efforts threw on decode
// and requestAllCodexModels failed atomically, leaving the Codex picker empty.
const decodeModelListResponse = Schema.decodeUnknownEffect(CodexSchema.V2ModelListResponse);

it.effect("decodes a model/list response reporting max/ultra reasoning efforts", () =>
  Effect.gen(function* () {
    const response = yield* decodeModelListResponse({
      data: [
        {
          defaultReasoningEffort: "max",
          description: "GPT-5.6 Sol",
          displayName: "GPT-5.6 Sol",
          hidden: false,
          id: "gpt-5.6-sol",
          isDefault: true,
          model: "gpt-5.6-sol",
          supportedReasoningEfforts: [
            { description: "Maximum reasoning effort.", reasoningEffort: "max" },
            { description: "Ultra reasoning effort.", reasoningEffort: "ultra" },
            // Open-string behavior: an effort slug unknown at generation time still decodes.
            { description: "A future effort slug.", reasoningEffort: "hyperspeed" },
          ],
        },
      ],
    });

    assert.equal(response.data[0]?.defaultReasoningEffort, "max");
    assert.deepEqual(
      response.data[0]?.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      ["max", "ultra", "hyperspeed"],
    );
  }),
);

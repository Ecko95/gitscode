import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-shared-barrel-import");

describe("t3code/no-shared-barrel-import", () => {
  rule.valid("allows subpath imports", `import { someUtil } from "@t3tools/shared/git";`);

  rule.valid(
    "allows subpath imports with another subpath",
    `import type { Foo } from "@t3tools/shared/types";`,
  );

  rule.invalid(
    "flags bare @t3tools/shared static import",
    `import { something } from "@t3tools/shared";`,
    (output) => {
      assert.match(output, /no-shared-barrel-import/);
    },
  );

  rule.invalid(
    "flags bare @t3tools/shared require call",
    `const x = require("@t3tools/shared");`,
    (output) => {
      assert.match(output, /no-shared-barrel-import/);
    },
  );
});

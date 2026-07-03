import { definePlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noSharedBarrelImport from "./rules/no-shared-barrel-import.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-shared-barrel-import": noSharedBarrelImport,
  },
});

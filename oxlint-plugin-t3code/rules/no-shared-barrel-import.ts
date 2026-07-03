import { defineRule } from "@oxlint/plugins";

// @t3tools/shared uses explicit subpath exports — there is no barrel index.
// Importing the bare package silently resolves to nothing (or a future
// accidental barrel). All consumers must use @t3tools/shared/<subpath>.
// See AGENTS.md § Package Roles.

const BARE_SPECIFIER = "@t3tools/shared";
const BANNED_MESSAGE =
  'Import from "@t3tools/shared" is banned. Use a subpath: @t3tools/shared/<name>.';

const isBareSharedSpecifier = (value: unknown): boolean =>
  typeof value === "string" && value === BARE_SPECIFIER;

// Read the string value out of any literal-shaped node without relying on a
// discriminant that tsgo sometimes fails to narrow in union types.
const literalStringValue = (node: unknown): string | undefined => {
  if (typeof node !== "object" || node === null) return undefined;
  const v = (node as Record<string, unknown>)["value"];
  return typeof v === "string" ? v : undefined;
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow bare @t3tools/shared imports; use a subpath such as @t3tools/shared/git instead.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (isBareSharedSpecifier(node.source.value)) {
          context.report({ node: node.source, message: BANNED_MESSAGE });
        }
      },
      ImportExpression(node) {
        // dynamic import("@t3tools/shared")
        if (isBareSharedSpecifier(literalStringValue(node.source))) {
          context.report({ node: node.source, message: BANNED_MESSAGE });
        }
      },
      CallExpression(node) {
        // require("@t3tools/shared")
        const callee = node.callee;
        if (callee.type !== "Identifier" || callee.name !== "require") return;

        const firstArg = node.arguments[0];
        if (firstArg !== undefined && isBareSharedSpecifier(literalStringValue(firstArg))) {
          context.report({ node: callee, message: BANNED_MESSAGE });
        }
      },
    };
  },
});

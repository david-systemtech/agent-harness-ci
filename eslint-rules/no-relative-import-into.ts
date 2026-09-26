import path from "node:path";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./create-rule.js";

/**
 * Dependency direction for relative imports: a relative specifier that
 * resolves into one of the workspace packages `packages` names
 * (`<root>/packages/<name>/`) is refused. The specifier is resolved against
 * the importing file as tsc and vitest resolve it, so every spelling of the
 * same path is the same import: `./` before or between the `../`, a doubled
 * slash, a climb that goes down and back up (`../../contracts/../cli/`),
 * back down through `packages/`, or out of the repository and in again by
 * its folder's name. `no-restricted-imports` matches the specifier as
 * written, which no pattern can normalise; the configuration keeps it for
 * the packages' names.
 *
 * Checked: import and re-export declarations, and a dynamic `import()` of a
 * string.
 */
export const rule = createRule<[{ readonly root: string; readonly packages: readonly string[]; readonly because: string }], "into">({
  name: "no-relative-import-into",
  meta: {
    type: "problem",
    docs: { description: "A relative import resolves into none of the named workspace packages." },
    schema: [
      {
        type: "object",
        properties: {
          root: { type: "string", description: "The repository's root, absolute." },
          packages: { type: "array", items: { type: "string" }, description: "The folders under packages/ this code must not import from." },
          because: { type: "string", description: "Why, said with each report." },
        },
        required: ["root", "packages", "because"],
        additionalProperties: false,
      },
    ],
    messages: { into: "'{{source}}' is packages/{{name}}: {{because}}" },
  },
  defaultOptions: [{ root: "", packages: [], because: "" }],
  create(context, [{ root, packages, because }]) {
    const from = path.dirname(context.filename);
    const check = (node: TSESTree.Node, source: string) => {
      if (source !== "." && source !== ".." && !source.startsWith("./") && !source.startsWith("../")) return;
      const [top, name] = path.relative(root, path.resolve(from, source)).split(path.sep);
      if (top === "packages" && name !== undefined && packages.includes(name)) context.report({ node, messageId: "into", data: { source, name, because } });
    };
    const declared = (node: { readonly source: TSESTree.StringLiteral | null }) => {
      if (node.source) check(node.source, node.source.value);
    };
    return {
      ImportDeclaration: declared,
      ExportNamedDeclaration: declared,
      ExportAllDeclaration: declared,
      ImportExpression(node) {
        if (node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === "string") check(node.source, node.source.value);
      },
    };
  },
});

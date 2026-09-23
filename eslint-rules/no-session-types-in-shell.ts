import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./create-rule.js";

/**
 * ADR 0004, lint (b): the desktop shell interface module imports no session,
 * run or group type, so nothing about sessions, runs or organisation can pass
 * through the shell (docs/specs/client-runtime.md, "The desktop shell seam").
 *
 * The configuration applies this rule to the shell interface module only
 * (`packages/client-runtime/src/shell.ts`, or a `shell/` directory beside it).
 *
 * Definition. An imported name is a session type when one of its words, split
 * at camel-case humps, underscores and digits and compared ignoring case, is
 * in `SESSION_WORDS`: session, run, group, and event and summary, which the
 * specification also keeps off the shell ("no member takes or returns a
 * session, run, group, event or summary"). Plurals count. Whole words only,
 * so `Runtime` is not `Run`. One exception: `Session` directly after `Client`
 * (`ClientSessionToken`) is the pairing credential the shell's `secrets` member
 * stores, not a Session.
 *
 * Checked: every named import and every named re-export (`export { X } from`),
 * by the name it has in the module it comes from, and every qualifier of an
 * `import("...")` type. Any source counts, not only `@agent-harness/contracts`,
 * because a contracts type re-exported through another module is the same
 * leak. A namespace or default import, `export *` or a dynamic import of
 * contracts is refused outright, since its names cannot be checked one by one.
 */
export const SESSION_WORDS: ReadonlySet<string> = new Set([
  "session",
  "sessions",
  "run",
  "runs",
  "group",
  "groups",
  "event",
  "events",
  "summary",
  "summaries",
]);

const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

export const isSessionType = (name: string): boolean =>
  words(name).some(
    (word, i, all) => SESSION_WORDS.has(word) && !(word.startsWith("session") && all[i - 1] === "client"),
  );

const isContracts = (source: string): boolean =>
  source === "@agent-harness/contracts" || source.startsWith("@agent-harness/contracts/");

const nameOf = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;

const qualifierNames = (node: TSESTree.EntityName): TSESTree.Identifier[] => {
  switch (node.type) {
    case AST_NODE_TYPES.Identifier:
      return [node];
    case AST_NODE_TYPES.TSQualifiedName:
      return [...qualifierNames(node.left), node.right];
    default:
      return [];
  }
};

export const rule = createRule({
  name: "no-session-types-in-shell",
  meta: {
    type: "problem",
    docs: { description: "The desktop shell interface imports no session, run or group type (ADR 0004)." },
    schema: [],
    messages: {
      sessionType:
        "The desktop shell must not carry '{{name}}': nothing about sessions, runs or organisation passes through the shell (ADR 0004). Pass a string the runtime parses, or a title and body the renderer composed.",
      wholeContracts:
        "Import named types from contracts into the desktop shell interface, so each can be checked for session, run and group types (ADR 0004).",
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (node: TSESTree.Node, name: string) => {
      if (isSessionType(name)) context.report({ node, messageId: "sessionType", data: { name } });
    };
    return {
      ImportDeclaration(node) {
        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            check(specifier, nameOf(specifier.imported));
          } else if (isContracts(node.source.value)) {
            context.report({ node: specifier, messageId: "wholeContracts" });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source) return;
        for (const specifier of node.specifiers) check(specifier, nameOf(specifier.local));
      },
      ExportAllDeclaration(node) {
        if (isContracts(node.source.value)) context.report({ node, messageId: "wholeContracts" });
      },
      ImportExpression(node) {
        if (node.source.type === AST_NODE_TYPES.Literal && isContracts(String(node.source.value))) {
          context.report({ node, messageId: "wholeContracts" });
        }
      },
      TSImportType(node) {
        if (!node.qualifier) {
          if (isContracts(node.source.value)) context.report({ node, messageId: "wholeContracts" });
          return;
        }
        for (const part of qualifierNames(node.qualifier)) check(part, part.name);
      },
    };
  },
});

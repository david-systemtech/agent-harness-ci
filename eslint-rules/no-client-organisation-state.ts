import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./create-rule.js";

/**
 * ADR 0003, lint (a): clients hold no organisation state. In every client
 * package (the client runtime and the terminal UI now, the GUI and web when
 * they exist; the configuration scopes it) a store, atom, slice, reducer key,
 * preferences key, settings key or web-storage key whose name contains one of
 * `FORBIDDEN_WORDS`, ignoring case, is an error (docs/specs/session-state.md,
 * "The contract test and the lint"). The match is a plain substring, as the
 * specification words it, so `typingIndicatorStore` hits `pin`.
 *
 * Allowlisted:
 * - the client runtime's projection cache module and its outbox module
 *   (`ALLOWLISTED_MODULES`), where any name may appear;
 * - one presentation module per renderer package, `src/presentation.ts`
 *   (`PRESENTATION_MODULE`), where a name is allowed only if it is one of
 *   `PRESENTATION_KEYS`. Adding a presentation key means editing that list: a
 *   review event, not a lint error.
 *
 * What counts as each kind of name:
 * - store, atom or signal: a binding (variable, destructured variable, class
 *   property, object property) whose value is a call or `new` of one of
 *   `STORE_FACTORIES`, or whose own name ends in `Store`, `Atom` or `Slice`;
 * - slice: the `name` of `createSlice({ name })`, the first argument of
 *   `defineStore(name)`;
 * - reducer key: a key of `combineReducers({...})`, of `configureStore({
 *   reducer: {...} })` and of `createSlice({ reducers: {...} })`;
 * - preferences or settings key: every property key, nested ones included, in
 *   the value bound to a variable whose name contains `pref` or `setting`, and
 *   every property of an interface or type alias so named;
 * - storage key: the first argument of `get`, `set`, `has`, `delete`, `remove`,
 *   `read`, `write`, `put`, `update`, `getItem`, `setItem` or `removeItem`
 *   called on anything whose name contains `pref`, `setting` or `storage`
 *   (`localStorage`, `platform.storage`, `preferences`); the storage key of a
 *   persisted atom (`atomWithStorage(key)`, `persistentAtom(key)`);
 * - web-storage key: a property read or written directly on `localStorage` or
 *   `sessionStorage`; an IndexedDB object store name
 *   (`createObjectStore`, `objectStore`, `deleteObjectStore`).
 * Keys are read from identifiers, string literals and the static text of
 * template literals. A computed key is not checked.
 */
export const FORBIDDEN_WORDS = [
  "archive",
  "pin",
  "order",
  "group",
  "tag",
  "settle",
  "snooze",
  "title",
  "rename",
] as const;

/** The presentation module's keys. Client-local presentation, never organisation state (glossary: Pane). */
export const PRESENTATION_KEYS: readonly string[] = ["collapsedHeadings", "paneLayout", "sidebarWidth"];

/** The client runtime's projection cache and outbox: a module file or a directory of that name. */
export const ALLOWLISTED_MODULES: readonly RegExp[] = [
  /\/packages\/client-runtime\/src\/projection-cache(\.tsx?$|\/)/,
  /\/packages\/client-runtime\/src\/outbox(\.tsx?$|\/)/,
];

/** A renderer's presentation module; the client runtime holds no presentation (glossary: Pane). */
export const PRESENTATION_MODULE = /\/packages\/(?!client-runtime\/)[^/]+\/src\/presentation\.tsx?$/;

export const STORE_FACTORIES: ReadonlySet<string> = new Set(
  [
    "atom",
    "atomFamily",
    "atomWithDefault",
    "atomWithReducer",
    "atomWithStorage",
    "configureStore",
    "createSignal",
    "createSlice",
    "createStore",
    "defineStore",
    "observable",
    "persistentAtom",
    "readable",
    "signal",
    "store",
    "writable",
  ].map((f) => f.toLowerCase()),
);

const STORE_NAME = /(store|atom|slice)$/i;
const PREFERENCE_HOLDER = /pref|setting/i;
const STORAGE_HOLDER = /pref|setting|storage/i;
const STORAGE_METHODS = new Set([
  "get",
  "set",
  "has",
  "delete",
  "remove",
  "read",
  "write",
  "put",
  "update",
  "getItem",
  "setItem",
  "removeItem",
]);
const WEB_STORAGE = new Set(["localStorage", "sessionStorage"]);
const WEB_STORAGE_API = new Set(["getItem", "setItem", "removeItem", "clear", "key", "length"]);
const OBJECT_STORE_METHODS = new Set(["createObjectStore", "objectStore", "deleteObjectStore"]);
const PERSISTED_ATOMS = new Set(["atomwithstorage", "persistentatom"]);

export const forbiddenWord = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  return FORBIDDEN_WORDS.find((word) => lower.includes(word));
};

/** The static text of a string or template literal, or of an identifier or key. */
const textOf = (node: TSESTree.Node): string | undefined => {
  switch (node.type) {
    case AST_NODE_TYPES.Identifier:
    case AST_NODE_TYPES.PrivateIdentifier:
      return node.name;
    case AST_NODE_TYPES.Literal:
      return typeof node.value === "string" ? node.value : undefined;
    case AST_NODE_TYPES.TemplateLiteral:
      return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("");
    default:
      return undefined;
  }
};

const stringOf = (node: TSESTree.Node | undefined): string | undefined =>
  node && node.type !== AST_NODE_TYPES.Identifier ? textOf(node) : undefined;

/** The name a key has when written literally: `a`, `"a"`, `["a"]`; not `[a]`. */
const keyOf = (key: TSESTree.Node, computed: boolean): string | undefined =>
  computed ? stringOf(key) : textOf(key);

/** The last name of a callee or holder: `f`, `x.f`, `this.x.f`. */
const lastName = (node: TSESTree.Node): string | undefined => {
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (node.type === AST_NODE_TYPES.MemberExpression) return keyOf(node.property, node.computed);
  if (node.type === AST_NODE_TYPES.ChainExpression) return lastName(node.expression);
  return undefined;
};

const unwrap = (node: TSESTree.Node): TSESTree.Node => {
  switch (node.type) {
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
    case AST_NODE_TYPES.AwaitExpression:
      return unwrap(node.type === AST_NODE_TYPES.AwaitExpression ? node.argument : node.expression);
    default:
      return node;
  }
};

/** Whether a value is made by a call or `new` of a store factory. */
const isStoreFactory = (value: TSESTree.Node | null | undefined): boolean => {
  if (!value) return false;
  const node = unwrap(value);
  if (node.type !== AST_NODE_TYPES.CallExpression && node.type !== AST_NODE_TYPES.NewExpression) return false;
  return STORE_FACTORIES.has(lastName(node.callee)?.toLowerCase() ?? "");
};

const objectArgument = (node: TSESTree.CallExpression, index = 0): TSESTree.ObjectExpression | undefined => {
  const arg = node.arguments[index];
  const value = arg && unwrap(arg);
  return value?.type === AST_NODE_TYPES.ObjectExpression ? value : undefined;
};

const propertyValue = (object: TSESTree.ObjectExpression, name: string): TSESTree.Node | undefined => {
  for (const p of object.properties) {
    if (p.type === AST_NODE_TYPES.Property && keyOf(p.key, p.computed) === name) return unwrap(p.value);
  }
  return undefined;
};

export const rule = createRule({
  name: "no-client-organisation-state",
  meta: {
    type: "problem",
    docs: {
      description: "Client packages hold no store, preference or storage key named after session organisation state (ADR 0003).",
    },
    schema: [],
    messages: {
      organisationState:
        "'{{name}}' names client state after session organisation ('{{word}}'). That state is the environment's (ADR 0003): read it from the client runtime's projections and change it by command. Only the client runtime's projection cache and outbox, and the presentation keys listed in eslint-rules/no-client-organisation-state.ts, may hold such a name.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (ALLOWLISTED_MODULES.some((module) => module.test(filename))) return {};
    const presentation = PRESENTATION_MODULE.test(filename);
    const reported = new Set<TSESTree.Node>();

    const check = (node: TSESTree.Node, name: string | undefined) => {
      if (name === undefined || reported.has(node)) return;
      if (presentation && PRESENTATION_KEYS.includes(name)) return;
      const word = forbiddenWord(name);
      if (!word) return;
      reported.add(node);
      context.report({ node, messageId: "organisationState", data: { name, word } });
    };

    const checkLiteral = (node: TSESTree.Node | undefined) => {
      if (node) check(node, stringOf(unwrap(node)));
    };

    const checkKeys = (object: TSESTree.Node | undefined) => {
      if (object?.type !== AST_NODE_TYPES.ObjectExpression) return;
      for (const p of object.properties) {
        if (p.type === AST_NODE_TYPES.Property) check(p.key, keyOf(p.key, p.computed));
      }
    };

    /** Every key in a preferences or settings value, through nesting, arrays and calls; not into functions. */
    const checkPreferenceValue = (value: TSESTree.Node | null | undefined): void => {
      if (!value) return;
      const node = unwrap(value);
      switch (node.type) {
        case AST_NODE_TYPES.ObjectExpression:
          for (const p of node.properties) {
            if (p.type !== AST_NODE_TYPES.Property) continue;
            check(p.key, keyOf(p.key, p.computed));
            checkPreferenceValue(p.value);
          }
          return;
        case AST_NODE_TYPES.ArrayExpression:
          for (const element of node.elements) if (element) checkPreferenceValue(element);
          return;
        case AST_NODE_TYPES.CallExpression:
        case AST_NODE_TYPES.NewExpression:
          for (const arg of node.arguments) checkPreferenceValue(arg);
          return;
      }
    };

    /** Every property of a preferences or settings type, through nested type literals. */
    const checkPreferenceType = (members: readonly TSESTree.TypeElement[]): void => {
      for (const member of members) {
        if (member.type !== AST_NODE_TYPES.TSPropertySignature) continue;
        check(member.key, keyOf(member.key, member.computed));
        const type = member.typeAnnotation?.typeAnnotation;
        if (type?.type === AST_NODE_TYPES.TSTypeLiteral) checkPreferenceType(type.members);
      }
    };

    const checkBinding = (target: TSESTree.Node, value: TSESTree.Node | null | undefined) => {
      const isFactory = isStoreFactory(value);
      const bind = (node: TSESTree.Node | null) => {
        if (!node) return;
        switch (node.type) {
          case AST_NODE_TYPES.Identifier:
            if (isFactory || STORE_NAME.test(node.name)) check(node, node.name);
            return;
          case AST_NODE_TYPES.ArrayPattern:
            node.elements.forEach(bind);
            return;
          case AST_NODE_TYPES.ObjectPattern:
            for (const p of node.properties) bind(p.type === AST_NODE_TYPES.Property ? p.value : p.argument);
            return;
          case AST_NODE_TYPES.AssignmentPattern:
            bind(node.left);
            return;
        }
      };
      bind(target);
    };

    return {
      VariableDeclarator(node) {
        checkBinding(node.id, node.init);
        if (node.id.type === AST_NODE_TYPES.Identifier && PREFERENCE_HOLDER.test(node.id.name)) {
          checkPreferenceValue(node.init);
        }
      },
      PropertyDefinition(node) {
        const name = keyOf(node.key, node.computed);
        if (name !== undefined && (isStoreFactory(node.value) || STORE_NAME.test(name))) check(node.key, name);
      },
      Property(node) {
        if (node.parent.type !== AST_NODE_TYPES.ObjectExpression) return;
        const name = keyOf(node.key, node.computed);
        if (name !== undefined && isStoreFactory(node.value)) check(node.key, name);
      },
      TSInterfaceDeclaration(node) {
        if (PREFERENCE_HOLDER.test(node.id.name)) checkPreferenceType(node.body.body);
      },
      TSTypeAliasDeclaration(node) {
        if (PREFERENCE_HOLDER.test(node.id.name) && node.typeAnnotation.type === AST_NODE_TYPES.TSTypeLiteral) {
          checkPreferenceType(node.typeAnnotation.members);
        }
      },
      CallExpression(node) {
        const callee = lastName(node.callee);
        if (callee === undefined) return;
        const factory = callee.toLowerCase();

        if (PERSISTED_ATOMS.has(factory) || factory === "definestore") checkLiteral(node.arguments[0]);
        if (factory === "createslice") {
          const options = objectArgument(node);
          if (options) {
            checkLiteral(propertyValue(options, "name"));
            checkKeys(propertyValue(options, "reducers"));
          }
        }
        if (factory === "combinereducers") checkKeys(objectArgument(node));
        if (factory === "configurestore") {
          const options = objectArgument(node);
          if (options) checkKeys(propertyValue(options, "reducer"));
        }
        if (OBJECT_STORE_METHODS.has(callee)) checkLiteral(node.arguments[0]);

        const member = node.callee.type === AST_NODE_TYPES.ChainExpression ? node.callee.expression : node.callee;
        if (member.type === AST_NODE_TYPES.MemberExpression && STORAGE_METHODS.has(callee)) {
          const holder = lastName(member.object);
          if (holder !== undefined && STORAGE_HOLDER.test(holder)) checkLiteral(node.arguments[0]);
        }
      },
      MemberExpression(node) {
        const holder = lastName(node.object);
        if (holder === undefined || !WEB_STORAGE.has(holder)) return;
        const key = keyOf(node.property, node.computed);
        if (key !== undefined && !WEB_STORAGE_API.has(key)) check(node.property, key);
      },
    };
  },
});

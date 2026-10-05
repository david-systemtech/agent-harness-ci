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
 *   (`PRESENTATION_MODULE`), where a name is allowed only if it is one of the
 *   `presentationKeys` option, by default `PRESENTATION_KEYS`. Adding a
 *   presentation key means editing that list: a review event, not a lint error.
 *
 * What counts as each kind of name:
 * - store: every module-scope binding except a `const` holding a function, a
 *   class or a constant literal (string, number, boolean, a template with no
 *   expressions), so `let` always counts; in any scope, a binding made by one of
 *   `FACTORIES` (the libraries the specifications name, and zustand's
 *   `create`), a binding of a state hook (`STATE_HOOKS`), and a class property
 *   whose name ends in Store, Atom or Slice;
 * - atom, slice and reducer key: what each factory's entry in `FACTORIES`
 *   extracts: a persisted atom's storage key, a slice's `name` and `reducers`
 *   keys, the keys of `combineReducers` and of `configureStore`'s `reducer`;
 * - preferences or settings key: every key of an object literal bound at
 *   module scope, nested ones included, whatever the binding is called; in any
 *   scope, every key in the value of a variable whose name contains `pref` or
 *   `setting`, and every property of an interface or type alias so named;
 * - storage key: the first argument of one of `STORAGE_METHODS` called on
 *   anything whose name contains `pref`, `setting`, `storage` or `documents`
 *   (`localStorage`, `platform.storage`, `preferences`, and the client
 *   runtime's `platform.documents`);
 * - web-storage key: a property read or written directly on `localStorage` or
 *   `sessionStorage`; an IndexedDB object store name (`OBJECT_STORE_METHODS`;
 *   the GUI's document storage is IndexedDB, docs/specs/client-runtime.md).
 *
 * Case: the forbidden words and the patterns for holder names and store
 * suffixes are words, matched ignoring case; every list of API names
 * (factories, hooks, methods) is matched exactly as the API spells it.
 * Names are read from identifiers, string literals and the static text of
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
  // The composer draft is a session field (#115): a client buffers it only in the outbox, never in a store of its own.
  "draft",
] as const;

/**
 * The presentation keys: client-local presentation, never organisation state
 * (glossary: Pane). Each is a key of a renderer's presentation module, save
 * `hiddenDirectories`, the client runtime's preference beside
 * `environments.lastUsed` (workspace-picker spec), which both renderers' pickers read.
 */
export const PRESENTATION_KEYS: readonly string[] = [
  "cachedTheme",
  "collapsedHeadings",
  "escStopsRun",
  "firstLaunchDone",
  "dismissedPairingAccess",
  "hiddenDirectories",
  "keyRemaps",
  "lightOrDark",
  "paneLayout",
  "readingWidth",
  "reasoningShown",
  "runLocalEnvironment",
  "settingsRow",
  "sideColumns",
  "browserPartitions",
  "sidebarShown",
  "sidebarView",
  "sidebarWidth",
  "streamingFade",
  "textSize",
];

/** The client runtime's projection cache and outbox: a module file or a directory of that name. */
export const ALLOWLISTED_MODULES: readonly RegExp[] = [
  /\/packages\/client-runtime\/src\/projection-cache(\.tsx?$|\/)/,
  /\/packages\/client-runtime\/src\/outbox(\.tsx?$|\/)/,
];

/** A renderer's presentation module. The client runtime has none: its one presentation key, `hiddenDirectories`, is a preference naming no forbidden word. */
export const PRESENTATION_MODULE = /\/packages\/(?!client-runtime\/)[^/]+\/src\/presentation\.tsx?$/;

const STORE_SUFFIX = /(store|atom|slice)$/i;
const PREFERENCE_HOLDER = /pref|setting/i;
const STORAGE_HOLDER = /pref|setting|storage|documents/i;
const STATE_HOOKS = new Set(["useState", "useReducer", "useRef"]);
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

export const forbiddenWord = (name: string): string | undefined => {
  const lower = name.toLowerCase();
  return FORBIDDEN_WORDS.find((word) => lower.includes(word));
};

// Reading names off the tree.

/** The text of a string literal or of a template literal's static parts. */
const staticString = (node: TSESTree.Node | undefined): string | undefined => {
  if (node?.type === AST_NODE_TYPES.Literal) return typeof node.value === "string" ? node.value : undefined;
  if (node?.type === AST_NODE_TYPES.TemplateLiteral) return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("");
  return undefined;
};

/** A property or member name as written: `a`, `#a`, `"a"`, `["a"]`; not `[a]`. */
const keyName = (key: TSESTree.Node, computed: boolean): string | undefined =>
  !computed && (key.type === AST_NODE_TYPES.Identifier || key.type === AST_NODE_TYPES.PrivateIdentifier)
    ? key.name
    : staticString(key);

/** The name a callee or receiver ends in: `f`, `x.f`, `this.x.f`, `x?.f`. */
const referenceName = (node: TSESTree.Node): string | undefined => {
  if (node.type === AST_NODE_TYPES.Identifier) return node.name;
  if (node.type === AST_NODE_TYPES.MemberExpression) return keyName(node.property, node.computed);
  if (node.type === AST_NODE_TYPES.ChainExpression) return referenceName(node.expression);
  return undefined;
};

const unwrap = (node: TSESTree.Node): TSESTree.Node => {
  switch (node.type) {
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
      return unwrap(node.expression);
    case AST_NODE_TYPES.AwaitExpression:
      return unwrap(node.argument);
    default:
      return node;
  }
};

const callOf = (node: TSESTree.Node | null | undefined): TSESTree.CallExpression | TSESTree.NewExpression | undefined => {
  const value = node && unwrap(node);
  return value?.type === AST_NODE_TYPES.CallExpression || value?.type === AST_NODE_TYPES.NewExpression
    ? value
    : undefined;
};

const objectArgument = (call: TSESTree.CallExpression): TSESTree.ObjectExpression | undefined => {
  const arg = call.arguments[0] && unwrap(call.arguments[0]);
  return arg?.type === AST_NODE_TYPES.ObjectExpression ? arg : undefined;
};

const propertyValue = (object: TSESTree.ObjectExpression | undefined, name: string): TSESTree.Node | undefined => {
  for (const p of object?.properties ?? []) {
    if (p.type === AST_NODE_TYPES.Property && keyName(p.key, p.computed) === name) return unwrap(p.value);
  }
  return undefined;
};

/** A name found in the source, and the node to report it on. */
interface Named {
  node: TSESTree.Node;
  name: string | undefined;
}

const keysOf = (object: TSESTree.Node | undefined): Named[] =>
  object?.type === AST_NODE_TYPES.ObjectExpression
    ? object.properties.flatMap((p) =>
        p.type === AST_NODE_TYPES.Property ? [{ node: p.key, name: keyName(p.key, p.computed) }] : [],
      )
    : [];

const firstArgument = (call: TSESTree.CallExpression): Named[] =>
  call.arguments[0] ? [{ node: call.arguments[0], name: staticString(unwrap(call.arguments[0])) }] : [];

const none = (): Named[] => [];

/**
 * Store factories, each with the names it defines beyond the binding it
 * returns: jotai (`atom`, and `atomWithStorage`, whose key is a web-storage
 * key), Redux Toolkit, zustand's `create`, and the observables the client
 * runtime exposes (docs/specs/client-runtime.md): `observable` and `signal`
 * in general, and the runtime's own `writable` and `derived`.
 */
export const FACTORIES: ReadonlyMap<string, (call: TSESTree.CallExpression) => Named[]> = new Map([
  ["atom", none],
  ["atomWithStorage", firstArgument],
  ["create", none],
  ["createStore", none],
  ["signal", none],
  ["observable", none],
  ["writable", none],
  ["derived", none],
  [
    "createSlice",
    (call) => {
      const options = objectArgument(call);
      const name = propertyValue(options, "name");
      return [...(name ? [{ node: name, name: staticString(name) }] : []), ...keysOf(propertyValue(options, "reducers"))];
    },
  ],
  ["combineReducers", (call) => keysOf(objectArgument(call))],
  ["configureStore", (call) => keysOf(propertyValue(objectArgument(call), "reducer"))],
]);

const isFactoryCall = (node: TSESTree.Node | null | undefined): boolean => {
  const call = callOf(node);
  return call !== undefined && FACTORIES.has(referenceName(call.callee) ?? "");
};

const isStateHookCall = (node: TSESTree.Node | null | undefined): boolean => {
  const call = callOf(node);
  return call?.type === AST_NODE_TYPES.CallExpression && STATE_HOOKS.has(referenceName(call.callee) ?? "");
};

/** A `const` at module scope holding one of these is a constant, not a store. */
const isConstantValue = (node: TSESTree.Node): boolean => {
  const value = unwrap(node);
  switch (value.type) {
    case AST_NODE_TYPES.FunctionExpression:
    case AST_NODE_TYPES.ArrowFunctionExpression:
    case AST_NODE_TYPES.ClassExpression:
      return true;
    case AST_NODE_TYPES.Literal:
      return ["string", "number", "boolean"].includes(typeof value.value);
    case AST_NODE_TYPES.TemplateLiteral:
      return value.expressions.length === 0;
    default:
      return false;
  }
};

const isModuleScope = (declaration: TSESTree.VariableDeclaration): boolean =>
  !declaration.declare &&
  (declaration.parent.type === AST_NODE_TYPES.Program ||
    (declaration.parent.type === AST_NODE_TYPES.ExportNamedDeclaration &&
      declaration.parent.parent.type === AST_NODE_TYPES.Program));

/** Every identifier a binding pattern binds. */
const boundNames = (pattern: TSESTree.Node | null): Named[] => {
  if (!pattern) return [];
  switch (pattern.type) {
    case AST_NODE_TYPES.Identifier:
      return [{ node: pattern, name: pattern.name }];
    case AST_NODE_TYPES.ArrayPattern:
      return pattern.elements.flatMap(boundNames);
    case AST_NODE_TYPES.ObjectPattern:
      return pattern.properties.flatMap((p) => boundNames(p.type === AST_NODE_TYPES.Property ? p.value : p.argument));
    case AST_NODE_TYPES.AssignmentPattern:
      return boundNames(pattern.left);
    case AST_NODE_TYPES.RestElement:
      return boundNames(pattern.argument);
    default:
      return [];
  }
};

/** Every key in an object value, through nesting, arrays and call arguments; not into functions. */
const nestedKeys = (value: TSESTree.Node | null | undefined): Named[] => {
  if (!value) return [];
  const node = unwrap(value);
  switch (node.type) {
    case AST_NODE_TYPES.ObjectExpression:
      return node.properties.flatMap((p) =>
        p.type === AST_NODE_TYPES.Property ? [{ node: p.key, name: keyName(p.key, p.computed) }, ...nestedKeys(p.value)] : [],
      );
    case AST_NODE_TYPES.ArrayExpression:
      return node.elements.flatMap((element) => nestedKeys(element));
    case AST_NODE_TYPES.CallExpression:
    case AST_NODE_TYPES.NewExpression:
      return node.arguments.flatMap((arg) => nestedKeys(arg));
    default:
      return [];
  }
};

/** Every property of a type, through nested type literals. */
const typeKeys = (members: readonly TSESTree.TypeElement[]): Named[] =>
  members.flatMap((member) => {
    if (member.type !== AST_NODE_TYPES.TSPropertySignature) return [];
    const type = member.typeAnnotation?.typeAnnotation;
    return [
      { node: member.key, name: keyName(member.key, member.computed) },
      ...(type?.type === AST_NODE_TYPES.TSTypeLiteral ? typeKeys(type.members) : []),
    ];
  });

// What each visitor finds.

const variableNames = (node: TSESTree.VariableDeclarator): Named[] => {
  const declaration = node.parent;
  const moduleScope = isModuleScope(declaration);
  const isStore =
    isFactoryCall(node.init) ||
    isStateHookCall(node.init) ||
    (moduleScope && (declaration.kind !== "const" || !node.init || !isConstantValue(node.init)));
  const holdsPreferences = node.id.type === AST_NODE_TYPES.Identifier && PREFERENCE_HOLDER.test(node.id.name);
  return [
    ...(isStore ? boundNames(node.id) : []),
    ...(moduleScope || holdsPreferences ? nestedKeys(node.init) : []),
  ];
};

const classPropertyNames = (node: TSESTree.PropertyDefinition): Named[] => {
  const name = keyName(node.key, node.computed);
  return name !== undefined && (isFactoryCall(node.value) || STORE_SUFFIX.test(name)) ? [{ node: node.key, name }] : [];
};

const objectPropertyNames = (node: TSESTree.Property): Named[] =>
  node.parent.type === AST_NODE_TYPES.ObjectExpression && isFactoryCall(node.value)
    ? [{ node: node.key, name: keyName(node.key, node.computed) }]
    : [];

const interfaceNames = (node: TSESTree.TSInterfaceDeclaration): Named[] =>
  PREFERENCE_HOLDER.test(node.id.name) ? typeKeys(node.body.body) : [];

const typeAliasNames = (node: TSESTree.TSTypeAliasDeclaration): Named[] =>
  PREFERENCE_HOLDER.test(node.id.name) && node.typeAnnotation.type === AST_NODE_TYPES.TSTypeLiteral
    ? typeKeys(node.typeAnnotation.members)
    : [];

const callNames = (node: TSESTree.CallExpression): Named[] => {
  const callee = referenceName(node.callee);
  if (callee === undefined) return [];
  const factory = FACTORIES.get(callee);
  if (factory) return factory(node);
  if (OBJECT_STORE_METHODS.has(callee)) return firstArgument(node);
  const member = node.callee.type === AST_NODE_TYPES.ChainExpression ? node.callee.expression : node.callee;
  if (member.type === AST_NODE_TYPES.MemberExpression && STORAGE_METHODS.has(callee)) {
    const holder = referenceName(member.object);
    if (holder !== undefined && STORAGE_HOLDER.test(holder)) return firstArgument(node);
  }
  return [];
};

const webStorageNames = (node: TSESTree.MemberExpression): Named[] => {
  const holder = referenceName(node.object);
  if (holder === undefined || !WEB_STORAGE.has(holder)) return [];
  const key = keyName(node.property, node.computed);
  return key !== undefined && !WEB_STORAGE_API.has(key) ? [{ node: node.property, name: key }] : [];
};

export const rule = createRule<[{ presentationKeys?: readonly string[] }], "organisationState">({
  name: "no-client-organisation-state",
  meta: {
    type: "problem",
    docs: {
      description: "Client packages hold no store, preference or storage key named after session organisation state (ADR 0003).",
    },
    schema: [
      {
        type: "object",
        properties: { presentationKeys: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      organisationState:
        "'{{name}}' names client state after session organisation ('{{word}}'). That state is the environment's (ADR 0003): read it from the client runtime's projections and change it by command. Only the client runtime's projection cache and outbox, and the presentation keys listed in eslint-rules/no-client-organisation-state.ts, may hold such a name.",
    },
  },
  defaultOptions: [{ presentationKeys: PRESENTATION_KEYS }],
  create(context, [{ presentationKeys = PRESENTATION_KEYS }]) {
    const filename = context.filename.replaceAll("\\", "/");
    if (ALLOWLISTED_MODULES.some((module) => module.test(filename))) return {};
    const allowed = new Set(PRESENTATION_MODULE.test(filename) ? presentationKeys : []);
    const reported = new Set<TSESTree.Node>();

    const report = (names: Named[]) => {
      for (const { node, name } of names) {
        if (name === undefined || allowed.has(name) || reported.has(node)) continue;
        const word = forbiddenWord(name);
        if (!word) continue;
        reported.add(node);
        context.report({ node, messageId: "organisationState", data: { name, word } });
      }
    };

    return {
      VariableDeclarator: (node) => report(variableNames(node)),
      PropertyDefinition: (node) => report(classPropertyNames(node)),
      Property: (node) => report(objectPropertyNames(node)),
      TSInterfaceDeclaration: (node) => report(interfaceNames(node)),
      TSTypeAliasDeclaration: (node) => report(typeAliasNames(node)),
      CallExpression: (node) => report(callNames(node)),
      MemberExpression: (node) => report(webStorageNames(node)),
    };
  },
});

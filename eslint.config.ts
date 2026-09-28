import css from "@eslint/css";
import eslint from "@eslint/js";
import type { Linter } from "eslint";
import { builtinModules } from "node:module";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import { plugin } from "./eslint-rules/index.js";

/** Every client package: the client runtime and the terminal UI now, the GUI and web when they exist. */
const clientPackageNames = ["client-runtime", "tui", "gui", "web"];
const clientPackages = clientPackageNames.map((p) => `packages/${p}/**/*.{ts,tsx}`);
/** The renderers: every client package but the runtime they render from. */
const rendererPackages = clientPackageNames.filter((p) => p !== "client-runtime").map((p) => `packages/${p}/**/*.{ts,tsx}`);
/** One alternation over every client package name, for the import bans below. */
const anyClient = clientPackageNames.join("|");

/** Every script's extension, TypeScript's and JavaScript's. */
const scripts = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/**
 * The packages that paint with the theme's tokens (ADR 0023): the GUI, the desktop shell and the browser tab, and any
 * renderer package added later. The terminal UI keeps the terminal's own sixteen colours and is not one.
 */
const tokenPackages = ["gui", "desktop", "web"];
/**
 * The two places a painting package may write a literal colour (ADR 0023), each a module name wherever the package keeps it:
 * xterm's fallback theme, the terminal pane's colours before the theme is read, and the preview frame's content, a document's own colours.
 */
const literalColourAllowed = ["**/xterm-fallback-theme.ts", "**/preview-frame-content.{ts,tsx,css}"];

/**
 * The renderers whose one bundle runs in a browser tab (the desktop window loads it too): the GUI, and the browser tab's
 * own package when it exists (docs/specs/gui.md, "Packages and the platform").
 */
const browserPackages = ["gui", "web"];
/** Every Node built-in as an import names it, bare (`fs`, `fs/promises`) or `node:`-prefixed (`node:sqlite`, which is only that). */
const nodeBuiltins = `node:.*|(${builtinModules.map((name) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(/.*)?`;

/** Why the environment imports no client and not the CLI. */
const environmentOnly = "The environment depends on contracts, never on a client or the CLI.";

/** `no-restricted-imports` refusing every import whose specifier matches `regex`. */
const forbidImports = (regex: string, message: string): Linter.RulesRecord => ({
  "no-restricted-imports": ["error", { patterns: [{ regex, message }] }],
});

export default defineConfig([
  // `.ci/` is david/ci, which CI checks out inside the workspace.
  globalIgnores(["**/dist/", "**/coverage/", ".tsbuild/", ".ci/"]),
  // The JavaScript rules read scripts only: a stylesheet has no comments or tokens of theirs to read.
  { files: [`**/*.${scripts}`], extends: [eslint.configs.recommended, tseslint.configs.recommended] },
  { plugins: { "agent-harness": plugin } },

  // ADR 0003, lint (a): no client store or preference named after session organisation state.
  // Test files are left out: their module-scope fixtures model the environment's data, not client state.
  {
    files: clientPackages,
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "agent-harness/no-client-organisation-state": "error" },
  },

  // ADR 0004, lint (b): the desktop shell interface carries no session, run or group type.
  {
    files: ["packages/client-runtime/src/shell.ts", "packages/client-runtime/src/shell/**/*.ts"],
    rules: { "agent-harness/no-session-types-in-shell": "error" },
  },

  // ADR 0023: every colour a window paints is a token, in the painting packages' scripts, tests included, and stylesheets.
  {
    files: tokenPackages.map((p) => `packages/${p}/**/*.${scripts}`),
    ignores: literalColourAllowed,
    rules: { "agent-harness/no-literal-colour": "error" },
  },
  // Stylesheets through ESLint's CSS language, tolerant of the at-rules and the `--color-*` reset Tailwind 4 adds to CSS.
  {
    files: tokenPackages.map((p) => `packages/${p}/**/*.css`),
    ignores: literalColourAllowed,
    plugins: { css },
    language: "css/css",
    languageOptions: { tolerant: true },
    rules: { "agent-harness/no-literal-colour": "error" },
  },

  // Dependency direction, as source imports; test/workspace.test.ts holds the manifests to the same rules.
  {
    files: ["packages/contracts/**/*.ts"],
    rules: forbidImports(
      "^(@agent-harness/(?!contracts(/|$))|agent-harness(/|$))",
      "contracts depends on no other workspace package; the others depend on it.",
    ),
  },
  {
    files: ["packages/client-runtime/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: forbidImports(
      "^(?!@agent-harness/contracts(/|$)|\\.)",
      "The client runtime depends on contracts and nothing else at run time; what it cannot own comes from the platform (docs/specs/client-runtime.md).",
    ),
  },
  {
    files: ["packages/theme/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: forbidImports(
      "^(?!@agent-harness/contracts(/|$)|\\.)",
      "The theme package depends on contracts and nothing else: pure maths, no UI and no session state, so every client and the environment can use it (ADR 0023).",
    ),
  },
  {
    files: ["packages/environment/**/*.ts"],
    rules: {
      ...forbidImports(`^(@agent-harness/(${anyClient})|agent-harness)(/|$)`, environmentOnly),
      // A relative path into a client's or the CLI's folder is the same import, its tests included, however it is spelled:
      // the rule resolves it against the importing file, which no pattern over the specifier can.
      "agent-harness/no-relative-import-into": ["error", { root: import.meta.dirname, packages: [...clientPackageNames, "cli"], because: environmentOnly }],
    },
  },
  {
    files: rendererPackages,
    rules: forbidImports(
      "^(@agent-harness/environment|agent-harness)(/|$)",
      "A renderer is a pure client: it renders from the client runtime and runs no environment.",
    ),
  },
  // Its tests read files and build under Node; its source runs in a browser tab, so it takes no Electron and no Node either.
  {
    files: browserPackages.map((p) => `packages/${p}/src/**/*.{ts,tsx}`),
    ignores: ["**/*.test.{ts,tsx}"],
    rules: forbidImports(
      `^((@agent-harness/environment|agent-harness|electron)(/|$)|(${nodeBuiltins})$)`,
      "The GUI's bundle runs in a browser tab too (milestone 2): it imports the client runtime, contracts and theme, never Electron, a Node built-in or the environment.",
    ),
  },
]);

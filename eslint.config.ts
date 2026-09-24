import eslint from "@eslint/js";
import type { Linter } from "eslint";
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

/** `no-restricted-imports` refusing every import whose specifier matches `regex`. */
const forbidImports = (regex: string, message: string): Linter.RulesRecord => ({
  "no-restricted-imports": ["error", { patterns: [{ regex, message }] }],
});

export default defineConfig([
  // `.ci/` is david/ci, which CI checks out inside the workspace.
  globalIgnores(["**/dist/", "**/coverage/", ".tsbuild/", ".ci/"]),
  eslint.configs.recommended,
  tseslint.configs.recommended,
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
    files: ["packages/environment/**/*.ts"],
    rules: forbidImports(
      `^(@agent-harness/(${anyClient})|agent-harness)(/|$)`,
      "The environment depends on contracts, never on a client or the CLI.",
    ),
  },
  {
    files: rendererPackages,
    rules: forbidImports(
      "^(@agent-harness/environment|agent-harness)(/|$)",
      "A renderer is a pure client: it renders from the client runtime and runs no environment.",
    ),
  },
]);

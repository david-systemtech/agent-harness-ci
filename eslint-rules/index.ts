import type { ESLint } from "eslint";
import { rule as noClientOrganisationState } from "./no-client-organisation-state.js";
import { rule as noRelativeImportInto } from "./no-relative-import-into.js";
import { rule as noSessionTypesInShell } from "./no-session-types-in-shell.js";

/**
 * The repository's own lint rules, registered under the `agent-harness/` prefix.
 * The rules are typed with typescript-eslint's rule context, which ESLint's
 * own Plugin type does not accept although the objects are the same at run
 * time; hence the one cast.
 */
export const plugin = {
  meta: { name: "agent-harness" },
  rules: {
    "no-client-organisation-state": noClientOrganisationState,
    "no-relative-import-into": noRelativeImportInto,
    "no-session-types-in-shell": noSessionTypesInShell,
  },
} as unknown as ESLint.Plugin;

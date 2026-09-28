import { defineProject, mergeConfig, type UserWorkspaceConfig } from "vitest/config";

/**
 * Each package's project. Workspace imports resolve to TypeScript source
 * through the `@agent-harness/source` export condition, so tests never wait on
 * a build; `dist` is what `tsc -b` emits. Setting the conditions replaces
 * Vite's defaults, so its defaults are listed after ours: the server's for a
 * test under Node, the client's for a test in jsdom (`@vitest-environment
 * jsdom`), which Vite resolves as a browser would.
 */
export const packageProject = (name: string, overrides: UserWorkspaceConfig = {}) =>
  mergeConfig(
    defineProject({
      ssr: { resolve: { conditions: ["@agent-harness/source", "module", "node", "development|production"] } },
      resolve: { conditions: ["@agent-harness/source", "module", "browser", "development|production"] },
      test: {
    // Spawning tsx or running ESLint takes seconds on a loaded CI runner; 5 s flapped there.
    testTimeout: 30_000, name, include: ["src/**/*.test.ts"] },
    }),
    overrides,
  );

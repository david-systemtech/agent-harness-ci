import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      {
        // The same timeout the packages get (vitest.shared.ts): the first ESLint run of the lint-configuration suite took 7 s on a loaded CI runner and flapped at 5 s.
        test: { name: "repo", include: ["test/**/*.test.ts", "eslint-rules/**/*.test.ts"], testTimeout: 30_000 },
      },
    ],
  },
});

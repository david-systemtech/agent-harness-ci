import { defineConfig } from "vitest/config";
import { packageProject } from "./vitest.shared.js";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      // The repository's own tests (its scripts', workflows' and lint rules') run as a package's do: the same 30-second
      // timeout (the first ESLint run of the lint-configuration suite took 7 s on a loaded CI runner and flapped at 5 s),
      // and workspace imports resolved to source, so the install scripts' tests use the release build's zip writer
      // and the CLI's Path line without a build.
      packageProject("repo", { test: { include: ["test/**/*.test.ts", "eslint-rules/**/*.test.ts"] } }),
    ],
  },
});

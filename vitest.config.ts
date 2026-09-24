import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      {
        test: { name: "repo", include: ["test/**/*.test.ts", "eslint-rules/**/*.test.ts"] },
      },
    ],
  },
});

import { fileURLToPath } from "node:url";
import { packageProject } from "../../vitest.shared.js";

// Every test renders in jsdom unless it says otherwise, with the DOM's gaps filled for Radix and React Testing Library (test/setup.ts).
// React's development build, whatever the shell's NODE_ENV: its production build has no `act`, which Testing Library renders through.
// The smoke tests through the real spine live in `test/` beside the harness, in jsdom over Node's module resolution
// (`@vitest-environment jsdom-on-node`, the name resolved to test/jsdom-on-node.ts); the rest in `src/`.
export default packageProject("gui", {
  resolve: { alias: { "vitest-environment-jsdom-on-node": fileURLToPath(new URL("./test/jsdom-on-node.ts", import.meta.url)) } },
  test: { include: ["src/**/*.test.tsx", "test/**/*.test.tsx"], environment: "jsdom", setupFiles: ["test/setup.ts"], env: { NODE_ENV: "test" } },
});

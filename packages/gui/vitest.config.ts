import { packageProject } from "../../vitest.shared.js";

// Every test renders in jsdom unless it says otherwise, with the DOM's gaps filled for Radix and React Testing Library (test/setup.ts).
// React's development build, whatever the shell's NODE_ENV: its production build has no `act`, which Testing Library renders through.
export default packageProject("gui", {
  test: { include: ["src/**/*.test.tsx"], environment: "jsdom", setupFiles: ["test/setup.ts"], env: { NODE_ENV: "test" } },
});

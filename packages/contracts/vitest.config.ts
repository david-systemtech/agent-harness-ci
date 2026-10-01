import { packageProject } from "../../vitest.shared.js";

// The bank validator's build test (scripts/) runs Vite under Node and the built file with Node.
export default packageProject("contracts", { test: { include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] } });

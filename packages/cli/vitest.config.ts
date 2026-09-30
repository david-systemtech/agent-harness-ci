import { packageProject } from "../../vitest.shared.js";

// The release build's tests (scripts/release) run beside the CLI's own.
export default packageProject("cli", { test: { include: ["scripts/**/*.test.ts"] } });

import { packageProject } from "../../vitest.shared.js";

// The smoke tests through the real spine live in `test/` beside the harness; the rest in `src/`.
export default packageProject("tui", { test: { include: ["test/**/*.test.ts"] } });

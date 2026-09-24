import { packageProject } from "../../vitest.shared.js";

// The primary seam starts an in-process environment per test, so files run one at a time (docs/specs/client-runtime.md, "Testing Decisions").
export default packageProject("client-runtime", { test: { fileParallelism: false } });

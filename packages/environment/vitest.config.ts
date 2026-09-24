import { packageProject } from "../../vitest.shared.js";

// Each test file will start a listener, so files run one at a time.
export default packageProject("environment", { test: { fileParallelism: false } });

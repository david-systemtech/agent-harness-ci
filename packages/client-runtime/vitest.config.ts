import { packageProject } from "../../vitest.shared.js";

// Files run in parallel: the in-process environment each test starts listens on loopback port 0 (docs/specs/client-runtime.md, "Testing Decisions").
export default packageProject("client-runtime");

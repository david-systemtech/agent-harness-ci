import { packageProject } from "../../vitest.shared.js";

// Files run in parallel: every listener a test starts takes loopback port 0. Run one at a time, the suite took 14 minutes on a CI runner.
export default packageProject("environment");

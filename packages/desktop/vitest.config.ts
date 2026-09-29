import { packageProject } from "../../vitest.shared.js";

// The main process's modules under Node, with Electron's modules faked (test/fake-electron.ts): no test loads Electron,
// whose package downloads its binary when Node first requires it.
export default packageProject("desktop");

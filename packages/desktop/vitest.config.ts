import { packageProject } from "../../vitest.shared.js";

// The main process's modules under Node, with Electron's modules faked (test/fake-electron.ts): no test loads Electron,
// whose package downloads its binary when Node first requires it. The desktop build's tests (scripts/desktop-build)
// run beside them, with electron-builder faked.
export default packageProject("desktop", { test: { include: ["scripts/**/*.test.ts"] } });

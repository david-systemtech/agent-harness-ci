import { packageProject } from "../../vitest.shared.js";

// Every test runs under Node, the options page's in a jsdom window it makes over the page's markup, each against
// the fake `chrome` API (test/fake-chrome.ts) and a scripted environment on a loopback WebSocket
// (test/scripted-environment.ts); no test loads a browser. The build's tests (scripts/) run Vite under Node.
export default packageProject("extension", { test: { include: ["scripts/**/*.test.ts"] } });

import { createRequire } from "node:module";
import { builtinEnvironments, type Environment } from "vitest/environments";

/**
 * jsdom's window over Node's modules, for the smoke tests through the real
 * spine (`smoke.test.tsx`, which names it `@vitest-environment
 * jsdom-on-node`; vitest.config.ts resolves the name to this file). The
 * window renders in jsdom as every GUI test does, while the in-process
 * environment it talks to loads as Node loads it (its `node:` built-ins, its
 * server conditions), which the jsdom environment's browser resolution
 * refuses.
 *
 * One more thing differs from jsdom's own environment: the WebSocket. jsdom's
 * runs on Node's (undici), which builds its events from the global `Event`,
 * jsdom's here, and cannot dispatch them on Node's `EventTarget`. The
 * environment's own `ws`, whose events are its own, stands in for it, so
 * the runtime and the environment's test client connect as they do under Node.
 */

/** The `ws` package, as the environment's tests have it. */
const requireFromEnvironment = createRequire(new URL("../../environment/package.json", import.meta.url));
const { WebSocket } = requireFromEnvironment("ws") as { readonly WebSocket: unknown };

const jsdomOnNode: Environment = {
  name: "jsdom-on-node",
  viteEnvironment: "ssr",
  async setup(global, options) {
    const jsdom = await builtinEnvironments.jsdom.setup(global, options);
    (global as { WebSocket: unknown }).WebSocket = WebSocket;
    return jsdom;
  },
};

export default jsdomOnNode;

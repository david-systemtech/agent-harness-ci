import { useCleanups } from "../../environment/test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../environment/test/helper.js";
import { originOf } from "../src/connections/address.js";
import { createRuntimeWithSeams, type InternalOptions, type RuntimeWithSeams } from "../src/internal.js";
import type { Runtime } from "../src/runtime.js";
import type { Observable } from "../src/observable.js";
import type { GrantReader, HttpFetch, Platform, WebSocketFactory } from "../src/platform.js";
import { globalFetch, globalWebSocket } from "../src/testing/in-memory-platform.js";

export { originOf };

/**
 * The primary seam (docs/specs/client-runtime.md, "Testing Decisions"): the
 * runtime on the in-memory platform against the in-process environment of
 * #108, over a real WebSocket. Everything a test starts is closed after it,
 * newest first, so a runtime closes before its environment.
 */

/** How long a test waits for a condition, in real time. */
export const WAIT_MS = 3000;

/** Resolves once `condition` holds, polling in real time; rejects after `WAIT_MS`. */
export const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${WAIT_MS} ms waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/**
 * The first value of `observable` that `condition` holds for: the one it has now, else the first it changes to. Waits on
 * the change itself, with no deadline of its own, so a loaded runner is bounded by the test's timeout alone.
 */
export const holds = <T>(observable: Observable<T>, condition: (value: T) => boolean): Promise<T> =>
  new Promise((resolve) => {
    if (condition(observable.read())) return resolve(observable.read());
    const stop = observable.subscribe((value) => {
      if (!condition(value)) return;
      stop();
      resolve(value);
    });
  });

/** A grant reader over the environment's grant file, as a desktop's shell or the terminal UI reads it. */
export const grantReader = (t: TestEnvironment): GrantReader => ({ read: async () => t.grant() });

export const useHarness = () => {
  const { onCleanup } = useCleanups();
  return {
    onCleanup,
    async environment(options?: TestEnvironmentOptions): Promise<TestEnvironment> {
      const t = await startTestEnvironment(options);
      onCleanup(() => t.close());
      return t;
    },
    runtime(platform: Platform, options?: InternalOptions): Runtime {
      return this.withSeams(platform, options).runtime;
    },
    /** The runtime and the internal seams #126 to #128 attach to. */
    withSeams(platform: Platform, options?: InternalOptions): RuntimeWithSeams {
      const made = createRuntimeWithSeams(platform, options);
      onCleanup(() => made.runtime.close());
      return made;
    },
  };
};

/** A WebSocket factory over Node's own, recording every URL it opens. */
export const recordingWebSocket = (base: WebSocketFactory = globalWebSocket()) => {
  const urls: string[] = [];
  const factory: WebSocketFactory = (url, handlers) => {
    urls.push(url);
    return base(url, handlers);
  };
  return { factory, urls };
};

/** A WebSocket factory that passes every frame from the environment through `rewrite` while `active()`: a scripted tweak on a real wire. */
export const rewritingWebSocket = (
  rewrite: (frame: Record<string, unknown>) => Record<string, unknown>,
  active: () => boolean,
  base: WebSocketFactory = globalWebSocket(),
): WebSocketFactory => (url, handlers) =>
  base(url, {
    ...handlers,
    onMessage: (text) =>
      handlers.onMessage(active() ? JSON.stringify(rewrite(JSON.parse(text) as Record<string, unknown>)) : text),
  });

/** A fetch that passes the JSON answered at a path ending in `suffix` through `rewrite` while `active()`. */
export const rewritingFetch = (
  suffix: string,
  rewrite: (body: Record<string, unknown>) => Record<string, unknown>,
  active: () => boolean = () => true,
  base: HttpFetch = globalFetch(),
): HttpFetch => async (url, request) => {
  const response = await base(url, request);
  if (!active() || !url.endsWith(suffix)) return response;
  const body = rewrite((await response.json()) as Record<string, unknown>);
  return { status: response.status, json: async () => body };
};

/** A fetch that answers `status` with a body that is not JSON at a path ending in `suffix` while `active()`, as a proxy's error page or an empty 204 does. */
export const notJsonAt = (suffix: string, status: number, active: () => boolean = () => true, base: HttpFetch = globalFetch()): HttpFetch => async (url, request) =>
  active() && url.endsWith(suffix) ? { status, json: () => Promise.reject(new SyntaxError("Unexpected token '<'")) } : base(url, request);

/** A fetch that fails as an unreachable host does while `down()`. */
export const failingFetch = (down: () => boolean, base: HttpFetch = globalFetch()): HttpFetch => async (url, request) => {
  if (down()) throw new TypeError("fetch failed");
  return base(url, request);
};

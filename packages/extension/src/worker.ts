import type { ExtensionChrome } from "./chrome.js";
import { systemClock } from "./clock.js";
import { ownFileReader } from "./port.js";
import { startWorker } from "./service-worker.js";

/** Chrome's own, of which the worker uses the part `ExtensionChrome` types. */
declare const chrome: ExtensionChrome;

// The service worker's script, which Chrome runs at each start of the worker: its listeners are added as it first runs.
startWorker({ chrome, clock: systemClock, readOwnFile: ownFileReader(chrome, (url, init) => fetch(url, init)) });

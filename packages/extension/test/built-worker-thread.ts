import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { EXTENSION_ID, EXTENSION_ORIGIN } from "@agent-harness/contracts";
import { WebSocket as NodeWebSocket } from "ws";
import { NAME_KEY, PAIRING_KEY, PORT_OVERRIDE_KEY } from "../src/stored.js";
import { fakeChrome } from "./fake-chrome.js";

/**
 * A thread that runs a built extension's worker as Chrome runs it (#549,
 * #553), loaded through tsx by the test that starts it: the `worker.js` of
 * the built folder, its global `chrome` the fake holding the folder's
 * manifest, whose tabs are the scripted CDP peer's at `browser`, its
 * `fetch` of the extension's own addresses reading the folder, as Chrome
 * serves them, and its sockets carrying the extension's Origin, as Chrome's
 * do, which an environment's listener admits. The thread's end is the worker's: its timers and its socket
 * go with it, as Chrome's idle shutdown takes them.
 *
 * The profile's local storage starts as `local`, so a test starts a worker
 * again on the profile another one left. The test asks, by message:
 *
 * - `{ type: "page", request }`: what the options page sends the worker
 *   (`connect`, `pair`), answered `{ type: "page", answer }`;
 * - `{ type: "local" }`: the profile's local storage, answered
 *   `{ type: "local", local }`.
 */

/** What the test hands the thread. */
export interface BuiltWorkerData {
  /** The built extension's folder. */
  readonly folder: string;
  /** The scripted CDP peer's DevTools address, the browser the profile's tabs are in. */
  readonly browser?: string;
  /** The profile's local storage at the start. */
  readonly local?: Record<string, unknown>;
}

const { folder, browser, local } = workerData as BuiltWorkerData;
const origin = `chrome-extension://${EXTENSION_ID}/`;
const port = parentPort;
if (port === null) throw new Error("The built worker's thread runs only as a worker thread.");

const chrome = fakeChrome(JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")) as { version: string; version_name?: string }, browser === undefined ? {} : { browser });
if (local !== undefined) await chrome.storage.local.set(local);
/** A socket as Chrome opens one for the extension: its handshake carries the extension's Origin. */
class ExtensionWebSocket extends NodeWebSocket {
  constructor(address: string | URL) {
    super(address, { origin: EXTENSION_ORIGIN });
  }
}

Object.assign(globalThis, {
  chrome,
  WebSocket: ExtensionWebSocket,
  fetch: async (url: string): Promise<Response> => {
    if (!url.startsWith(origin)) throw new TypeError("Failed to fetch");
    return new Response(await readFile(join(folder, url.slice(origin.length)), "utf8"));
  },
});

port.on("message", (message: { readonly type: string; readonly request?: unknown }) => {
  if (message.type === "page") void chrome.runtime.sendMessage(message.request).then((answer) => port.postMessage({ type: "page", answer }));
  if (message.type === "local") void chrome.storage.local.get([PAIRING_KEY, NAME_KEY, PORT_OVERRIDE_KEY]).then((stored) => port.postMessage({ type: "local", local: stored }));
});

await import(pathToFileURL(join(folder, "worker.js")).href);

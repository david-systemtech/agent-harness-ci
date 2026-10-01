import { PORT_FILE_NAME, PortFile } from "@agent-harness/contracts";
import type { ExtensionChrome } from "./chrome.js";

/**
 * The port file (browser spec, "The extension, its folder and its
 * listener"): the environment writes it into the extension's folder once its
 * listener is bound, and the extension reads it from its own folder at each
 * connection attempt, so a port that changed across a restart is found with
 * no Reload.
 */

/** Reads a file of the extension's own folder: its text, or null when it is not there. */
export type ReadOwnFile = (path: string) => Promise<string | null>;

/**
 * Chrome's reader of the extension's own folder: a fetch of the file's
 * `chrome-extension://` address that skips the cache, so a rewritten file
 * is read as it is now.
 */
export const ownFileReader =
  (chrome: Pick<ExtensionChrome, "runtime">, fetchFile: (url: string, init: RequestInit) => Promise<Response>): ReadOwnFile =>
  async (path) => {
    try {
      const response = await fetchFile(chrome.runtime.getURL(path), { cache: "no-store" });
      return response.ok ? await response.text() : null;
    } catch {
      // Chrome answers a file the folder does not hold with a failed fetch.
      return null;
    }
  };

/** The port file, or the sentence saying why there is none to read. */
export type PortReading = { readonly ok: true; readonly file: PortFile } | { readonly ok: false; readonly problem: string };

export const readPortFile = async (readOwnFile: ReadOwnFile): Promise<PortReading> => {
  const text = await readOwnFile(PORT_FILE_NAME);
  if (text === null) {
    return { ok: false, problem: "This extension's folder holds no port file yet: the environment writes one once it listens. Start the environment; this updates by itself." };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The port file in this extension's folder is not JSON. Restart the environment, which writes it again." };
  }
  const parsed = PortFile.safeParse(json);
  if (!parsed.success) return { ok: false, problem: "The port file in this extension's folder does not name a port. Restart the environment, which writes it again." };
  return { ok: true, file: parsed.data };
};

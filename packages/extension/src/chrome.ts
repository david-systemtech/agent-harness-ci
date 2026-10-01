/**
 * The part of Chrome's extension API the extension uses, typed here rather
 * than taken whole from a types package: the worker and the options page
 * take it as a seam, so the tests hand them a fake (test/fake-chrome.ts)
 * and the entries hand them Chrome's own `chrome`. The shapes are Chrome's
 * promise-returning MV3 ones.
 */

/** An event a listener is added to, as Chrome's events are. */
export interface ChromeEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** One key's change in a storage area. */
export interface StorageChange {
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
}

/** A `chrome.storage` area: `local` keeps across restarts, `session` while the browser runs. */
export interface StorageArea {
  get(keys: string | readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  readonly onChanged: ChromeEvent<(changes: Record<string, StorageChange>) => void>;
}

export interface Alarm {
  readonly name: string;
}

/**
 * A listener for a message from another page of the extension. It answers
 * through `sendResponse`, and returns true when it will answer later.
 */
export type MessageListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined;

export interface ExtensionChrome {
  readonly runtime: {
    /** The address of a file in the extension's own folder. */
    getURL(path: string): string;
    getManifest(): { readonly version: string; readonly version_name?: string };
    /** Sends a message to the extension's other pages and its worker, waking the worker; answers the first response. */
    sendMessage(message: unknown): Promise<unknown>;
    readonly onMessage: ChromeEvent<MessageListener>;
  };
  readonly storage: { readonly local: StorageArea; readonly session: StorageArea };
  readonly alarms: {
    get(name: string): Promise<Alarm | undefined>;
    create(name: string, info: { readonly periodInMinutes: number }): Promise<void>;
    readonly onAlarm: ChromeEvent<(alarm: Alarm) => void>;
  };
}

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

/** What `chrome.debugger` attaches to: a tab. */
export interface Debuggee {
  readonly tabId?: number;
}

/**
 * Where a protocol command goes and an event came from: a tab's own target,
 * or, with `sessionId`, a child target attached under it (a cross-site
 * frame), which Chrome 125 gives an extension's debugger.
 */
export interface DebuggerSession extends Debuggee {
  readonly sessionId?: string;
}

/** A command's parameters, its result or an event's parameters, as the protocol sends them. */
export type ProtocolParams = Record<string, unknown>;

/** A tab as Chrome answers an extension without the `tabs` permission: its id and its group, never its address or title. */
export interface Tab {
  readonly id?: number;
  /** Its tab group's id, or -1 when it is in none. */
  readonly groupId: number;
}

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
  /** The DevTools protocol on a tab: Chrome shows its debugging banner on the tab while it is attached. */
  readonly debugger: {
    /** Rejects when a policy or the page forbids it, and when this extension is attached to the tab already. */
    attach(target: Debuggee, requiredVersion: string): Promise<void>;
    detach(target: Debuggee): Promise<void>;
    /** Resolves with the command's result; a protocol error rejects with its code and message as JSON text. */
    sendCommand(target: DebuggerSession, method: string, commandParams?: ProtocolParams): Promise<ProtocolParams | undefined>;
    /** Every event of every target this extension is attached to, a child target's with its session. */
    readonly onEvent: ChromeEvent<(source: DebuggerSession, method: string, params?: ProtocolParams) => void>;
    /** The debugger was let go of by the browser or the person (`target_closed`, `canceled_by_user`), never by the extension's own detach. */
    readonly onDetach: ChromeEvent<(source: Debuggee, reason: string) => void>;
  };
  readonly tabs: {
    create(properties: { readonly url?: string; readonly active?: boolean }): Promise<Tab>;
    /** Rejects when no tab has the id: it was closed. */
    get(tabId: number): Promise<Tab>;
    /** Puts the tabs in the group `groupId`, or in a new group when none is given, and answers the group's id; rejects for a group that is gone. */
    group(options: { readonly tabIds: number | readonly number[]; readonly groupId?: number }): Promise<number>;
    remove(tabIds: number | readonly number[]): Promise<void>;
  };
  readonly tabGroups: {
    update(groupId: number, properties: { readonly title?: string }): Promise<unknown>;
  };
}

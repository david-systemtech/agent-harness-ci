import { EXTENSION_ID } from "@agent-harness/contracts";
import type { Alarm, ChromeEvent, Debuggee, DebuggerSession, ExtensionChrome, MessageListener, ProtocolParams, StorageArea, StorageChange, Tab } from "../src/chrome.js";

/**
 * The fake `chrome` (browser spec, "Testing Decisions": the extension's
 * worker against a fake `chrome` API): the storage areas, the alarms and the
 * messaging the worker and the options page use, in memory, with Chrome's
 * shapes. One fake is one Chrome profile: its storage and alarms outlive a
 * worker, as Chrome's do, so a test stops a worker and starts another on
 * the same fake as Chrome's idle shutdown and the next wake would.
 *
 * Its tabs, tab groups and debugger are a browser's: the scripted CDP peer
 * (`@agent-harness/browser/testing`) at the DevTools address the test gives,
 * where a tab is a page target and `chrome.debugger` a flat session on it,
 * with Chrome's answers and errors and the child sessions of its cross-site
 * frames (#553).
 */

class FakeEvent<Listener extends (...args: never[]) => unknown> implements ChromeEvent<Listener> {
  readonly listeners = new Set<Listener>();

  addListener(listener: Listener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener): void {
    this.listeners.delete(listener);
  }
}

/** A storage area whose values are kept as JSON, as Chrome's are, and whose changes are heard after the write. */
class FakeStorageArea implements StorageArea {
  private readonly values = new Map<string, string>();
  readonly onChanged = new FakeEvent<(changes: Record<string, StorageChange>) => void>();

  get(keys: string | readonly string[]): Promise<Record<string, unknown>> {
    const answer: Record<string, unknown> = {};
    for (const key of typeof keys === "string" ? [keys] : keys) {
      const value = this.values.get(key);
      if (value !== undefined) answer[key] = JSON.parse(value);
    }
    return Promise.resolve(answer);
  }

  set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      const before = this.values.get(key);
      const after = JSON.stringify(value);
      this.values.set(key, after);
      changes[key] = { ...(before !== undefined && { oldValue: JSON.parse(before) as unknown }), newValue: JSON.parse(after) as unknown };
    }
    this.announce(changes);
    return Promise.resolve();
  }

  remove(keys: string | readonly string[]): Promise<void> {
    const changes: Record<string, StorageChange> = {};
    for (const key of typeof keys === "string" ? [keys] : keys) {
      const before = this.values.get(key);
      if (before === undefined) continue;
      this.values.delete(key);
      changes[key] = { oldValue: JSON.parse(before) as unknown };
    }
    if (Object.keys(changes).length > 0) this.announce(changes);
    return Promise.resolve();
  }

  /** What the area holds under `key` now, read as a page would. */
  peek(key: string): unknown {
    const value = this.values.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }

  private announce(changes: Record<string, StorageChange>): void {
    if (Object.keys(changes).length === 0) return;
    queueMicrotask(() => {
      for (const listener of this.onChanged.listeners) listener(changes);
    });
  }
}

/** A tab the extension made, as the fake holds it. */
export interface FakeTab {
  readonly id: number;
  /** The page target behind it in the scripted peer. */
  readonly targetId: string;
  /** Its tab group's id, or -1. */
  readonly groupId: number;
}

export interface FakeChromeOptions {
  /** The scripted CDP peer's DevTools address (`peer.listen()`), the browser whose tabs the profile holds; without it, every tab and debugger call fails. */
  readonly browser?: string;
  /** A managed profile whose policy blocks the debugger: every attach is refused, as Chrome refuses it. */
  readonly debuggerBlocked?: boolean;
}

export interface FakeChrome extends ExtensionChrome {
  readonly storage: { readonly local: FakeStorageArea; readonly session: FakeStorageArea };
  /** The alarms created, by name, with their period in minutes. */
  readonly alarmsCreated: ReadonlyMap<string, number>;
  /** Fires the alarm `name` as Chrome would when its period passes. */
  fireAlarm(name: string): void;
  /** Every tab the extension made that is open, in the order it made them. */
  tabsOpen(): FakeTab[];
  /** A tab group's title, while the group has a tab. */
  groupTitle(groupId: number): string | undefined;
  /** The tabs the debugger is attached to now. */
  attachedTabs(): number[];
  /** The person drags the tab out of its group. */
  ungroup(tabId: number): void;
  /** The person clicks Cancel on the debugging banner: the debugger lets go, and the extension hears `canceled_by_user`. */
  cancelDebugging(tabId: number): void;
  /** The tab's page is one Chrome keeps extensions from: every attach to it is refused as Chrome refuses one. */
  refuseDebugger(tabId: number): void;
  /** Lets go of the browser's connection. */
  close(): void;
}

/** A protocol error as `chrome.debugger.sendCommand` rejects with it: its code and message as JSON text. */
const protocolError = (error: { readonly code?: number; readonly message?: string }): Error => new Error(JSON.stringify({ code: error.code ?? -32000, message: error.message ?? "" }));

/** A raw CDP client on the scripted peer's WebSocket, opened at its first command: Chrome's own end of the extension's debugger. */
const browserLink = (address: string | undefined, onEvent: (message: { readonly method: string; readonly params: ProtocolParams; readonly sessionId?: string }) => void) => {
  let socket: Promise<WebSocket> | undefined;
  let nextId = 1;
  const pending = new Map<number, { readonly resolve: (result: ProtocolParams) => void; readonly reject: (error: Error) => void }>();
  const open = (): Promise<WebSocket> =>
    (socket ??= new Promise((resolve, reject) => {
      if (address === undefined) return reject(new Error("This fake Chrome has no browser: give fakeChrome the scripted peer's address."));
      const ws = new WebSocket(address);
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", () => reject(new Error(`The fake Chrome could not reach its browser at ${address}.`)));
      ws.addEventListener("message", (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: ProtocolParams; result?: ProtocolParams; error?: { code?: number; message?: string }; sessionId?: string };
        if (typeof message.id === "number") {
          const owed = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) owed?.reject(protocolError(message.error));
          else owed?.resolve(message.result ?? {});
        } else if (typeof message.method === "string") {
          onEvent({ method: message.method, params: message.params ?? {}, ...(message.sessionId !== undefined && { sessionId: message.sessionId }) });
        }
      });
    }));
  return {
    async send(method: string, params: ProtocolParams = {}, sessionId?: string): Promise<ProtocolParams> {
      const ws = await open();
      const id = nextId++;
      const answered = new Promise<ProtocolParams>((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
      return answered;
    },
    close(): void {
      void socket?.then((ws) => ws.close()).catch(() => undefined);
    },
  };
};

/** The tabs, tab groups and debugger of a fake profile over the browser at `address`. */
const fakeBrowser = (address: string | undefined, debuggerBlocked: boolean) => {
  const onEvent = new FakeEvent<(source: DebuggerSession, method: string, params?: ProtocolParams) => void>();
  const onDetach = new FakeEvent<(source: Debuggee, reason: string) => void>();
  const tabs = new Map<number, { readonly id: number; readonly targetId: string; groupId: number }>();
  const titles = new Map<number, string | undefined>();
  /** Each attached tab's root session, and the tab each root session is on. */
  const roots = new Map<number, string>();
  const tabOfRoot = new Map<string, number>();
  /** Each child session's parent session. */
  const parents = new Map<string, string>();
  /** Root sessions the extension is letting go of: Chrome says nothing of its own detach. */
  const letGo = new Set<string>();
  /** The tabs whose page Chrome keeps the debugger from. */
  const refused = new Set<number>();
  let nextTab = 101;
  let nextGroup = 7;

  const rootOf = (sessionId: string): string | undefined => {
    for (let at: string | undefined = sessionId; at !== undefined; at = parents.get(at)) if (tabOfRoot.has(at)) return at;
    return undefined;
  };
  const forgetRoot = (root: string): void => {
    const tabId = tabOfRoot.get(root);
    tabOfRoot.delete(root);
    if (tabId !== undefined) roots.delete(tabId);
    for (const [child, parent] of [...parents]) if (rootOf(parent) === undefined || parent === root) parents.delete(child);
  };
  /** A group with no tab left is gone, as Chrome removes one. */
  const sweepGroups = (): void => {
    for (const groupId of [...titles.keys()]) if (![...tabs.values()].some((tab) => tab.groupId === groupId)) titles.delete(groupId);
  };

  const link = browserLink(address, ({ method, params, sessionId }) => {
    if (sessionId === undefined) {
      if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string" && tabOfRoot.has(params.sessionId)) {
        const root = params.sessionId;
        const tabId = tabOfRoot.get(root) as number;
        forgetRoot(root);
        if (!letGo.delete(root)) for (const listener of [...onDetach.listeners]) listener({ tabId }, "target_closed");
      }
      if (method === "Target.targetDestroyed") {
        for (const tab of [...tabs.values()]) if (tab.targetId === params.targetId) tabs.delete(tab.id);
        sweepGroups();
      }
      return;
    }
    const root = rootOf(sessionId);
    const tabId = root === undefined ? undefined : tabOfRoot.get(root);
    if (root === undefined || tabId === undefined) return;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") parents.set(params.sessionId, sessionId);
    const source: DebuggerSession = { tabId, ...(sessionId !== root && { sessionId }) };
    for (const listener of [...onEvent.listeners]) listener(source, method, structuredClone(params));
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") parents.delete(params.sessionId);
  });

  const tabOf = (tabId: number) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  };

  const chrome: Pick<ExtensionChrome, "debugger" | "tabs" | "tabGroups"> = {
    debugger: {
      async attach({ tabId }) {
        if (debuggerBlocked) throw new Error("Cannot attach to this target.");
        const tab = tabs.get(tabId ?? -1);
        if (!tab) throw new Error(`No tab with given id ${String(tabId)}.`);
        if (refused.has(tab.id)) throw new Error("Cannot attach to this target.");
        if (roots.has(tab.id)) throw new Error(`Another debugger is already attached to the tab with id: ${tab.id}.`);
        const { sessionId } = await link.send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
        roots.set(tab.id, sessionId as string);
        tabOfRoot.set(sessionId as string, tab.id);
      },
      async detach({ tabId }) {
        const root = roots.get(tabId ?? -1);
        if (root === undefined) throw new Error(`Debugger is not attached to the tab with id: ${String(tabId)}.`);
        letGo.add(root);
        forgetRoot(root);
        await link.send("Target.detachFromTarget", { sessionId: root }).catch(() => undefined);
      },
      async sendCommand({ tabId, sessionId }, method, params) {
        const root = roots.get(tabId ?? -1);
        if (root === undefined) throw new Error(`Debugger is not attached to the tab with id: ${String(tabId)}.`);
        if (sessionId !== undefined && rootOf(sessionId) !== root) throw protocolError({ message: "No session with given id" });
        return link.send(method, params ?? {}, sessionId ?? root);
      },
      onEvent,
      onDetach,
    },
    tabs: {
      async create({ url }) {
        const { targetId } = await link.send("Target.createTarget", { url: url ?? "about:blank" });
        const tab = { id: nextTab++, targetId: targetId as string, groupId: -1 };
        tabs.set(tab.id, tab);
        return { id: tab.id, groupId: tab.groupId };
      },
      async get(tabId): Promise<Tab> {
        const tab = tabOf(tabId);
        return { id: tab.id, groupId: tab.groupId };
      },
      async group({ tabIds, groupId }) {
        const grouped = (typeof tabIds === "number" ? [tabIds] : tabIds).map(tabOf);
        if (groupId !== undefined && !titles.has(groupId)) throw new Error(`No group with id: ${groupId}.`);
        const into = groupId ?? nextGroup++;
        if (!titles.has(into)) titles.set(into, undefined);
        for (const tab of grouped) tab.groupId = into;
        sweepGroups();
        return into;
      },
      async remove(tabIds) {
        for (const tabId of typeof tabIds === "number" ? [tabIds] : tabIds) await link.send("Target.closeTarget", { targetId: tabOf(tabId).targetId });
      },
    },
    tabGroups: {
      async update(groupId, { title }) {
        if (!titles.has(groupId)) throw new Error(`No group with id: ${groupId}.`);
        if (title !== undefined) titles.set(groupId, title);
        return { id: groupId, title: titles.get(groupId) };
      },
    },
  };

  return {
    chrome,
    tabsOpen: (): FakeTab[] => [...tabs.values()].map((tab) => ({ ...tab })),
    groupTitle: (groupId: number) => titles.get(groupId),
    attachedTabs: () => [...roots.keys()],
    ungroup(tabId: number) {
      tabOf(tabId).groupId = -1;
      sweepGroups();
    },
    cancelDebugging(tabId: number) {
      const root = roots.get(tabId);
      if (root === undefined) throw new Error(`The debugger is not attached to the tab ${tabId}.`);
      letGo.add(root);
      forgetRoot(root);
      void link.send("Target.detachFromTarget", { sessionId: root }).catch(() => undefined);
      for (const listener of [...onDetach.listeners]) listener({ tabId }, "canceled_by_user");
    },
    refuseDebugger: (tabId: number) => void refused.add(tabId),
    close: () => link.close(),
  };
};

/** A fake Chrome profile in which the extension of `manifest` is loaded, its tabs in the browser `options.browser` names. */
export const fakeChrome = (manifest: { readonly version: string; readonly version_name?: string }, options: FakeChromeOptions = {}): FakeChrome => {
  const onMessage = new FakeEvent<MessageListener>();
  const onAlarm = new FakeEvent<(alarm: Alarm) => void>();
  const alarms = new Map<string, number>();
  const { chrome: browser, ...browserControls } = fakeBrowser(options.browser, options.debuggerBlocked === true);

  return {
    ...browser,
    ...browserControls,
    runtime: {
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => manifest,
      onMessage,
      // As Chrome's: every listener hears the message, the first to answer is the answer, and with none listening it fails.
      sendMessage: (message) =>
        new Promise((resolve, reject) => {
          const listeners = [...onMessage.listeners];
          if (listeners.length === 0) return reject(new Error("Could not establish connection. Receiving end does not exist."));
          let answered = false;
          const sendResponse = (response: unknown) => {
            if (answered) return;
            answered = true;
            resolve(response);
          };
          const waiting = listeners.map((listener) => listener(structuredClone(message), { id: EXTENSION_ID }, sendResponse) === true);
          if (!waiting.includes(true) && !answered) resolve(undefined);
        }),
    },
    storage: { local: new FakeStorageArea(), session: new FakeStorageArea() },
    alarms: {
      get: (name) => Promise.resolve(alarms.has(name) ? { name } : undefined),
      create: (name, info) => {
        alarms.set(name, info.periodInMinutes);
        return Promise.resolve();
      },
      onAlarm,
    },
    alarmsCreated: alarms,
    fireAlarm(name) {
      if (!alarms.has(name)) throw new Error(`No alarm named ${name} was created.`);
      for (const listener of onAlarm.listeners) listener({ name });
    },
  };
};

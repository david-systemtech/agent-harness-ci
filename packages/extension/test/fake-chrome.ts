import { EXTENSION_ID } from "@agent-harness/contracts";
import type { Alarm, ChromeEvent, ExtensionChrome, MessageListener, StorageArea, StorageChange } from "../src/chrome.js";

/**
 * The fake `chrome` (browser spec, "Testing Decisions": the extension's
 * worker against a fake `chrome` API): the storage areas, the alarms and the
 * messaging the worker and the options page use, in memory, with Chrome's
 * shapes. One fake is one Chrome profile: its storage and alarms outlive a
 * worker, as Chrome's do, so a test stops a worker and starts another on
 * the same fake as Chrome's idle shutdown and the next wake would.
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

export interface FakeChrome extends ExtensionChrome {
  readonly storage: { readonly local: FakeStorageArea; readonly session: FakeStorageArea };
  /** The alarms created, by name, with their period in minutes. */
  readonly alarmsCreated: ReadonlyMap<string, number>;
  /** Fires the alarm `name` as Chrome would when its period passes. */
  fireAlarm(name: string): void;
}

/** A fake Chrome profile in which the extension of `manifest` is loaded. */
export const fakeChrome = (manifest: { readonly version: string; readonly version_name?: string }): FakeChrome => {
  const onMessage = new FakeEvent<MessageListener>();
  const onAlarm = new FakeEvent<(alarm: Alarm) => void>();
  const alarms = new Map<string, number>();

  return {
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

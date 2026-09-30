import type { KeychainBinding } from "../src/serve/keychain.js";

/** One call the vault made on the scripted keychain. */
export interface KeychainCall {
  readonly op: "get" | "set" | "delete";
  readonly service: string;
  readonly account: string;
  /** The value a `set` writes. */
  readonly value?: string;
}

export interface ScriptedKeychainOptions {
  /** How the binding loads: it loads (preset), it is not installed, or it is installed and does not load. */
  readonly load?: "loads" | "not-installed" | "does-not-load";
}

/**
 * The scripted OS keychain (#364): the binding the vault chooser loads, as a
 * map of entries by service and account, recording every call. `fail` makes
 * the calls it picks throw what it returns, and `mangle` makes the sets it
 * picks store something other than what they were given, as a keychain
 * that answers a read with another value would.
 */
export interface ScriptedKeychain {
  /** The loader to hand the chooser. */
  readonly load: () => Promise<KeychainBinding>;
  /** How many times the loader was called. */
  readonly loads: () => number;
  /** Every call, in order. */
  readonly calls: KeychainCall[];
  /** The entry of `account` under `service`, or undefined. */
  entry(service: string, account: string): string | undefined;
  /** The accounts of every entry under `service`, in the order they were first written. */
  accounts(service: string): string[];
  /** Picks the calls that fail, and what they throw; none by default. */
  fail: (call: KeychainCall) => Error | undefined;
  /** Picks the sets that store a changed value; none by default. */
  mangle: (call: KeychainCall) => boolean;
}

export const scriptedKeychain = (options: ScriptedKeychainOptions = {}): ScriptedKeychain => {
  const entries = new Map<string, Map<string, string>>();
  const underService = (service: string): Map<string, string> => {
    let held = entries.get(service);
    if (held === undefined) entries.set(service, (held = new Map()));
    return held;
  };
  let loads = 0;
  const keychain: ScriptedKeychain = {
    calls: [],
    fail: () => undefined,
    mangle: () => false,
    loads: () => loads,
    entry: (service, account) => entries.get(service)?.get(account),
    accounts: (service) => [...(entries.get(service)?.keys() ?? [])],
    load: async () => {
      loads += 1;
      if (options.load === "not-installed") {
        throw Object.assign(new Error("Cannot find package '@napi-rs/keyring' imported from the environment"), { code: "ERR_MODULE_NOT_FOUND" });
      }
      if (options.load === "does-not-load") throw new Error("Cannot find native binding for this platform");
      const called = (call: KeychainCall): void => {
        keychain.calls.push(call);
        const failure = keychain.fail(call);
        if (failure !== undefined) throw failure;
      };
      return {
        get: async (service, account) => {
          called({ op: "get", service, account });
          return entries.get(service)?.get(account);
        },
        set: async (service, account, value) => {
          const call = { op: "set", service, account, value } as const;
          called(call);
          underService(service).set(account, keychain.mangle(call) ? `${value} (changed)` : value);
        },
        delete: async (service, account) => {
          called({ op: "delete", service, account });
          entries.get(service)?.delete(account);
        },
      };
    },
  };
  return keychain;
};

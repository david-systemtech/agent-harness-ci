import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ContractError,
  chromeNameOf,
  pageKeyOf,
  type BrowserStatus,
  type ChromeChange,
  type ExtensionListenerStatus,
  type PageCall,
  type PageDriver,
  type PagePolicy,
  type PairedChrome,
  type PortFile,
} from "@agent-harness/contracts";
import { formatActor, type EventInput, type EventLog, type StreamRef } from "../event-log/event-log.js";
import { readDenylist } from "../permissions/denylist-store.js";
import type { Clock } from "../serve/clock.js";
import type { CommandContext, CommandRejection, MethodHandlers } from "../serve/methods.js";
import type { StateCheckers } from "../setup/check.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { readSettings } from "../settings/settings-store.js";
import { chromeStream, readChrome, readChromes, type ChromeRecord } from "./chromes.js";
import type { Resolver } from "./address-rules.js";
import { createExtensionDriver } from "./extension-driver.js";
import { extensionFolder, type FolderState } from "./extension-folder.js";
import { createHeadlessBrowser, type HeadlessBrowser } from "./headless.js";
import type { FoundExecutable } from "./headless-executable.js";
import type { BrowserLauncher } from "./headless-launch.js";
import { createExtensionListener, type ChromeDesk, type ExtensionListenerPorts } from "./listener.js";
import { createPairingCodes } from "./pairing-code.js";

/**
 * The browser service's extension half (browser spec, "The extension, its
 * folder and its listener"; ADR 0014, ADR 0024; #547, #548): the folder
 * Chrome loads, made at start and again when `browser.status` finds it
 * missing, the listener the extension dials, the port file that joins them,
 * the unpaired signal (`extension.seen` on the environment stream beside
 * the unpaired flag `browser.status` answers), and the paired Chromes.
 *
 * A good pairing code sent as `pair` on an announced socket makes a paired
 * Chrome: an id, a 32-byte secret kept in the vault and never in the log,
 * and a cleaned name, recorded as `chrome.paired` on the Chrome's own
 * stream. A later socket proves the secret on a nonce; a connection that
 * reports another extension version than the last recorded appends
 * `chrome.version-reported`. `browser.chromes.rename` and
 * `browser.chromes.unpair` change them; unpairing deletes the secret from
 * the vault once it commits and refuses the Chrome's socket. Every change,
 * connection and disconnection raises `chrome.updated`. The page policy is
 * sent on `paired` and `ready`, and again to every proved socket whenever
 * the settings or the denylist change it. The extension driver performs
 * verbs on a paired Chrome over its proved socket (#552): for this
 * environment's own runs, and through `browser.chromes.perform` for a local
 * client session.
 *
 * Beside it, the headless browser (#555, `headless.ts`): its source or why
 * it has none, which each run's resolution reads, and its part of
 * `browser.status`. Its frame judge reads the page policy held here, and
 * a settings change lets go of a browser the settings no longer name.
 */

/** Who the log says appended what no client asked for: `extension.seen`, a pairing, a connection. */
const BROWSER_ACTOR = formatActor({ kind: "system", id: "browser" });

/** Where the vault keeps each paired Chrome's secret: `chrome:<id>`. */
const VAULT_PREFIX = "chrome:";
const secretEntry = (chromeId: string): string => `${VAULT_PREFIX}${chromeId}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The Browser step's lines (setup-copy.md §5.11): skipped with no Chrome paired, every paired Chrome closed, an extension out of date. */
const NOT_CONNECTED = "Chrome is not connected. Optional.";
const CLOSED = "Chrome is closed, so agents cannot use it. Open Chrome. This updates by itself.";
const OUT_OF_DATE = "The Chrome extension is out of date. In chrome://extensions, choose reload on agent-harness.";

export interface BrowserServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment stream, which `environment.subscribe` follows. */
  readonly stream: StreamRef;
  readonly environmentId: string;
  /** The environment's name as it is now: the port file and `announced` carry it. */
  readonly name: () => string;
  readonly harnessVersion: string;
  readonly dataDir: string;
  /** The built extension the environment carries. */
  readonly extensionSource: string;
  /** The ports the listener tries. */
  readonly ports: ExtensionListenerPorts;
  /** Where each paired Chrome's secret is kept. */
  readonly vault: Vault;
  /** Where the headless browser runs, and how it is found, launched and has its navigation's names resolved. */
  readonly headless: HeadlessSeams;
}

/** The headless browser's seams: whether the install declared a container, the executable search, the launcher and the resolver. */
export interface HeadlessSeams {
  readonly declaredContainer: boolean;
  readonly find: (named: string | null) => FoundExecutable;
  readonly launch: BrowserLauncher;
  readonly resolve: Resolver;
}

export interface BrowserService {
  /**
   * Deletes the secrets of Chromes that are gone, binds the listener, then
   * makes the folder and writes the port file into it. Never rejects: what
   * fails, `browser.status` says.
   */
  start(): Promise<void>;
  /** `browser.status`, the folder made again first when it is missing. */
  status(): Promise<BrowserStatus>;
  /** The page driver of the paired Chrome `chromeId`, or of the plain My Chrome for null: the extension driver. */
  driverOf(chromeId: string | null): PageDriver;
  /** The headless browser: its availability, which each run's resolution reads, and its driver. */
  readonly headless: Pick<HeadlessBrowser, "availability" | "driver">;
  /** Browser health reads the live listener and chrome projection, without changing either. */
  readonly stateChecks: Pick<StateCheckers, "browser.present" | "browser.chrome-connected" | "browser.extension-current">;
  readonly handlers: MethodHandlers;
  close(): Promise<void>;
}

export const createBrowserService = (options: BrowserServiceOptions): BrowserService => {
  const { log, stream, vault } = options;
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const folder = extensionFolder({ dataDir: options.dataDir, source: options.extensionSource });
  const codes = createPairingCodes(options.clock);

  /** The page policy as the settings and the denylist's browser section say now; a disabled entry is not in it. */
  const policy = (): PagePolicy => {
    const settings = readSettings(reader);
    return {
      devSites: settings["browser.devSites"],
      evaluateEverywhere: settings["browser.evaluateEverywhere"],
      deepReadEverywhere: settings["browser.deepReadEverywhere"],
      browserDomains: readDenylist(reader).browserDomains.filter((entry) => entry.enabled),
    };
  };
  /**
   * The page policy last read: when the service is made, then at each `settings.updated` and `denylist.changed`, a
   * change that alters it being sent to every proved socket. A socket going live is sent the one held, so nothing is
   * read on a socket's way and a failing read cannot fail it.
   */
  let heldPolicy = policy();

  const headless = createHeadlessBrowser({
    dataDir: options.dataDir,
    clock: options.clock,
    settings: () => {
      const settings = readSettings(reader);
      return {
        allowRuns: settings["browser.headless.allowRuns"],
        endpoint: settings["browser.headless.endpoint"],
        executable: settings["browser.headless.executable"],
        limits: settings["browser.headless.limits"],
      };
    },
    policy: () => heldPolicy,
    rules: () => ({ internalHosts: readSettings(reader)["browser.internalHosts"], resolve: options.headless.resolve }),
    declaredContainer: options.headless.declaredContainer,
    find: options.headless.find,
    launch: options.headless.launch,
  });

  const notice = (chromeId: string, name: string, change: ChromeChange): EventInput => ({ type: "chrome.updated", payload: { chromeId, name, change } });

  /** Appends `events` on the Chrome's stream, then a `chrome.updated` for each of `changes`, in the transaction the context holds. */
  const record = (
    chrome: { readonly id: string; readonly name: string },
    events: readonly EventInput[],
    changes: readonly ChromeChange[],
    context: Pick<CommandContext, "tx" | "actor"> & { readonly commandId?: string },
  ): void => {
    const attribution = { tx: context.tx, actor: context.actor, ...(context.commandId !== undefined && { commandId: context.commandId }) };
    if (events.length > 0) log.append(chromeStream(chrome.id), events, attribution);
    log.append(stream, changes.map((change) => notice(chrome.id, chrome.name, change)), attribution);
  };

  /**
   * Records what no client asked for about the Chrome `chromeId`, in a transaction of its own, and nothing when it is
   * not paired. A failure, of the read or the append, is logged, never thrown at a socket.
   */
  const recordBySystem = (
    chromeId: string,
    what: string,
    entries: (chrome: ChromeRecord) => { readonly events: readonly EventInput[]; readonly changes: readonly ChromeChange[] },
  ): void => {
    try {
      const chrome = readChrome(reader, chromeId);
      if (chrome === undefined) return;
      const { events, changes } = entries(chrome);
      log.atomically((tx) => record(chrome, events, changes, { tx, actor: BROWSER_ACTOR }));
    } catch (error) {
      console.error(`Recording that the Chrome ${chromeId.toLowerCase()} ${what} failed:`, error);
    }
  };

  /** Deletes a secret no pairing holds; one left behind is deleted by the next start. */
  const forget = (chromeId: string): Promise<void> =>
    vault.delete(secretEntry(chromeId)).catch((error: unknown) => console.error(`Deleting the vault entry of the Chrome ${chromeId} failed; the next start deletes it:`, error));

  const noPairing = (): string => `${options.name()} holds no pairing for this Chrome. Pair it again from the extension's options page.`;

  const desk: ChromeDesk = {
    async pair({ code, name }, announce, open) {
      const taken = codes.take(code);
      if (!taken.ok) return taken;
      const chrome = { id: randomUUID(), name: chromeNameOf(name) };
      const secret = randomBytes(32).toString("hex");
      try {
        await vault.set(secretEntry(chrome.id), secret);
      } catch (error) {
        taken.give();
        return { ok: false, reason: `The environment could not keep this Chrome's secret, so it did not pair: ${messageOf(error)}` };
      }
      try {
        if (!open()) throw new Error("the extension's socket closed first");
        log.atomically((tx) =>
          record(chrome, [{ type: "chrome.paired", payload: { name: chrome.name, extensionVersion: announce.extensionVersion } }], ["paired"], { tx, actor: BROWSER_ACTOR }),
        );
      } catch (error) {
        taken.give();
        await forget(chrome.id);
        return { ok: false, reason: `The pairing could not be recorded: ${messageOf(error)}` };
      }
      return { ok: true, chromeId: chrome.id, secret };
    },

    async prove(hello, nonce, mac) {
      if (hello.environmentId.toLowerCase() !== options.environmentId.toLowerCase()) {
        return `This Chrome is paired with another environment, not ${options.name()}. Load the folder of the environment it is paired with, or pair it with ${options.name()} from the extension's options page.`;
      }
      const chrome = readChrome(reader, hello.chromeId);
      const secret = chrome === undefined ? undefined : await vault.get(secretEntry(chrome.id));
      if (secret === undefined) return noPairing();
      const expected = createHmac("sha256", Buffer.from(secret, "hex")).update(nonce, "utf8").digest();
      if (!timingSafeEqual(Buffer.from(mac, "hex"), expected)) return "The proof does not match this Chrome's pairing. Pair it again from the extension's options page.";
      // Unpaired while its secret was read: the pairing is gone.
      return readChrome(reader, hello.chromeId) === undefined ? noPairing() : true;
    },

    connected(hello) {
      recordBySystem(hello.chromeId, "connected", (chrome) =>
        hello.extensionVersion === chrome.lastReportedVersion
          ? { events: [], changes: ["connected"] }
          : { events: [{ type: "chrome.version-reported", payload: { extensionVersion: hello.extensionVersion } }], changes: ["version", "connected"] },
      );
    },

    disconnected(chromeId) {
      recordBySystem(chromeId, "disconnected", () => ({ events: [], changes: ["disconnected"] }));
    },

    policy: () => heldPolicy,
  };

  const listener = createExtensionListener({
    clock: options.clock,
    environment: { id: options.environmentId, name: options.name },
    onAnnounce: ({ protocolVersion, extensionVersion }) => {
      try {
        log.append(stream, [{ type: "extension.seen", payload: { protocolVersion, extensionVersion } }], { actor: BROWSER_ACTOR });
      } catch (error) {
        console.error("Recording that an unpaired extension was seen failed:", error);
      }
    },
    chromes: desk,
  });

  const driver = createExtensionDriver({
    chromes: () => readChromes(reader),
    isConnected: (chromeId) => listener.isConnected(chromeId),
    call: (chromeId, call, deadlineMs) => listener.call(chromeId, call, deadlineMs),
    environmentName: options.name,
  });

  let listening: ExtensionListenerStatus | undefined;
  let state: FolderState = { shippedVersion: null, problem: "The environment has not made the extension's folder yet." };
  let closed = false;
  let ensuring: Promise<void> = Promise.resolve();

  const portFile = (): PortFile | null =>
    listening?.state === "listening"
      ? { port: listening.port, environmentId: options.environmentId, environmentName: options.name(), harnessVersion: options.harnessVersion }
      : null;

  const ensure = (): Promise<void> => {
    if (closed) return ensuring;
    // Folder updates are serialized, so the latest promise also joins every
    // earlier rename or status update. Close seals this queue before joining it.
    ensuring = folder.ensure(portFile()).then((next) => {
      state = next;
    });
    return ensuring;
  };

  const status = async (): Promise<BrowserStatus> => {
    await ensure();
    return {
      listener: listening ?? { state: "not-listening", reason: "bind-failed", message: "The listener has not been started." },
      folder: { path: folder.path, problem: state.problem },
      shippedVersion: state.shippedVersion,
      unpairedConnected: listener.unpairedConnected(),
      headless: headless.status(),
    };
  };

  /** A paired Chrome as the list answers it: connected while it holds a proved socket, outdated while it reports another version than the folder's. */
  const listed = (chrome: ChromeRecord): PairedChrome => ({
    ...chrome,
    connected: listener.isConnected(chrome.id),
    outdated: state.shippedVersion !== null && chrome.lastReportedVersion !== state.shippedVersion,
  });

  const noChrome = (chromeId: string): CommandRejection<"not_found"> => ({
    code: "not_found",
    message: `No paired Chrome ${chromeId} is on this environment.`,
    data: { kind: "chrome", chromeId },
  });

  // The port file names the environment as it is now: a rename writes it again. The page policy follows the settings and
  // the denylist: a change that alters it is held, and sent to every proved socket.
  const stopFollowing = log.subscribe((event) => {
    if (event.streamKind === "session" && (event.type === "session.deleted" || event.type === "session.purged")) {
      void headless.release(pageKeyOf(options.environmentId, event.streamId));
    }
    if (event.streamKind === stream.kind && event.streamId === stream.id && event.type === "environment.renamed") void ensure();
    if (event.type !== "settings.updated" && event.type !== "denylist.changed") return;
    if (event.type === "settings.updated") headless.refresh();
    const next = policy();
    if (JSON.stringify(next) === JSON.stringify(heldPolicy)) return;
    heldPolicy = next;
    listener.sendPolicy(next);
  });

  return {
    async start() {
      // The secrets of Chromes unpaired while a deletion failed, or before a crash.
      try {
        const held = new Set(readChromes(reader).map((chrome) => secretEntry(chrome.id)));
        for (const key of await vault.keys()) if (key.startsWith(VAULT_PREFIX) && !held.has(key)) await vault.delete(key);
      } catch (error) {
        console.error("Deleting the vault entries of Chromes that are unpaired failed; the next start tries again:", error);
      }
      listening = await listener.listen(options.ports);
      await ensure();
      await headless.start();
    },
    status,
    driverOf: (chromeId) => driver.driverOf(chromeId),
    headless,
    stateChecks: {
      "browser.present": () => readChromes(reader).length > 0 || { reason: NOT_CONNECTED },
      // A closed Chrome is fixed by opening it, so Unpair stays in the card's More options, never offered as the fix.
      "browser.chrome-connected": () => readChromes(reader).some((chrome) => listener.isConnected(chrome.id)) || { reason: CLOSED, actions: ["check-again"] },
      "browser.extension-current": () => {
        const outdated = readChromes(reader).filter((chrome) => listed(chrome).outdated);
        return outdated.length === 0 || {
          reason: OUT_OF_DATE,
          details: outdated.map((chrome) => `${chrome.name}: extension ${chrome.lastReportedVersion}, this computer ships ${state.shippedVersion}`),
          targets: outdated.map((chrome) => ({ action: "reload", kind: "chrome", id: chrome.id, label: chrome.name })),
        };
      },
    },
    handlers: {
      "browser.status": () => status(),
      "browser.pairing.code": () => codes.live(),
      "browser.chromes.list": () => ({ chromes: readChromes(reader).map(listed) }),
      // Only a client on this machine drives a Chrome paired with it: the relay's client half, local through the bootstrap grant.
      "browser.chromes.perform": async ({ chromeId, ...call }, context) => {
        if (!context.clientSession.local) {
          throw new ContractError({
            code: "forbidden",
            message: "Only a local client session may drive a paired Chrome: a client on the Chrome's own machine.",
            data: { scope: "runs:drive", reason: "local" },
          });
        }
        return { outcome: await driver.perform(chromeId, call as PageCall) };
      },
      "browser.chromes.rename": ({ chromeId, name }, context) => {
        const aggregate = chromeStream(chromeId.toLowerCase());
        const chrome = readChrome(reader, chromeId);
        if (chrome === undefined) return { aggregate, rejected: noChrome(chromeId) };
        const renamed = { id: chrome.id, name: chromeNameOf(name) };
        if (renamed.name !== chrome.name) record(renamed, [{ type: "chrome.renamed", payload: { name: renamed.name } }], ["renamed"], context);
        return { aggregate, result: { chrome: listed({ ...chrome, name: renamed.name }) } };
      },
      "browser.chromes.unpair": ({ chromeId }, context) => {
        const aggregate = chromeStream(chromeId.toLowerCase());
        const chrome = readChrome(reader, chromeId);
        if (chrome === undefined) return { aggregate, rejected: noChrome(chromeId) };
        const was = listed(chrome);
        record(chrome, [{ type: "chrome.unpaired", payload: {} }], ["unpaired"], context);
        // Once it commits: the secret forgotten, then the socket refused, so the extension returns to unpaired.
        context.tx.afterCommit(() => {
          void forget(chrome.id).finally(() =>
            listener.drop(chrome.id, `This Chrome was unpaired from ${options.name()}. Pair it again from the extension's options page.`),
          );
        });
        return { aggregate, result: { chrome: was } };
      },
    },
    async close() {
      closed = true;
      stopFollowing();
      try {
        await Promise.all([listener.close(), headless.close()]);
      } finally {
        await ensuring;
      }
    },
  };
};

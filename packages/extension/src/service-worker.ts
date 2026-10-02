import { BRIDGE_PROTOCOL_VERSION, bridgeUrl, decodeFromEnvironment, encodeBridgeMessage, type BridgeFromExtension, type PagePolicy } from "@agent-harness/contracts";
import type { ExtensionChrome, MessageListener, StorageChange } from "./chrome.js";
import type { Clock } from "./clock.js";
import { pageRequestOf, type PairOutcome } from "./messages.js";
import { chromePages } from "./pages.js";
import { readPortFile, type ReadOwnFile } from "./port.js";
import { proofOf } from "./proof.js";
import { describeStatus, STATUS_KEY, type WorkerStatus } from "./status.js";
import { NAME_KEY, PAIRING_KEY, PORT_OVERRIDE_KEY, readName, readPairing, readPortOverride, type StoredPairing } from "./stored.js";

/**
 * The extension's service worker (browser spec, "The extension, its folder
 * and its listener"; ADR 0014, ADR 0024): it finds its environment by
 * itself and holds one socket to it.
 *
 * At each connection attempt it reads its port, the override set on the
 * options page while one is set and the port file in its own folder
 * otherwise, and dials `bridgeUrl` there. Holding no pairing it opens with
 * `announce` and keeps the socket; that open socket is the unpaired signal,
 * and a code typed on the options page goes as `pair` on it. Holding one it
 * opens with `hello` and answers the `challenge` with the proof, unless the
 * challenge names another environment than the one it paired with, which
 * it says instead of proving to it. A held socket is pinged every 20
 * seconds, which keeps Chrome from stopping the worker, and an alarm every
 * 30 seconds starts a stopped worker, which dials again.
 *
 * A refusal of its proof, or on its proved socket, is its pairing gone: it
 * forgets the pairing and announces again at once. A refusal of its opening
 * (another bridge version's Reload sentence, say) leaves the pairing as it
 * is, and so does a socket that closes with no refusal, as an environment
 * that stops or fails closes it; either is tried again later. A pairing
 * the options page forgets, for an environment gone for good, closes the
 * socket the same way, and the worker announces again at once.
 *
 * On a live socket, the one it proved itself on or paired on, it answers
 * each `call` with its page driver (`pages.ts`) under the page policy the
 * environment sent with `paired` or `ready` and again with each `policy`.
 * A call or a policy on a socket that is not live is out of turn: only an
 * environment the Chrome paired with drives its pages.
 */

/** The alarm that starts a stopped worker, which dials again. */
export const CONNECT_ALARM = "connect";

/** Every 30 seconds, the shortest period Chrome gives an alarm. */
const CONNECT_ALARM_MINUTES = 0.5;

/** Under Chrome's 30 seconds of idleness after which it stops a worker; a socket's traffic counts as activity. */
const PING_MS = 20_000;

/** How long each failed attempt waits before the next, the last repeated. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * The page policy the driver judges by until the first live socket sends
 * one: no page is attached before then, so it never judges one.
 */
const NO_POLICY_YET: PagePolicy = { devSites: [], evaluateEverywhere: false, deepReadEverywhere: false, browserDomains: [] };

export interface WorkerSeams {
  readonly chrome: ExtensionChrome;
  readonly readOwnFile: ReadOwnFile;
  readonly clock: Clock;
}

export interface RunningWorker {
  /** Stops the worker as Chrome's idle shutdown does: its socket closes, and its listeners and timers go with it. */
  stop(): void;
}

/** A `pair` sent on the announced socket, waiting for its answer. */
interface PendingPair {
  readonly name: string;
  readonly answer: (outcome: PairOutcome) => void;
}

/** Where a socket's conversation is. */
type Phase =
  | { readonly kind: "dialling" }
  | { readonly kind: "announcing" }
  | { readonly kind: "announced"; readonly environmentId: string; readonly environmentName: string; readonly pair?: PendingPair }
  | { readonly kind: "hello"; readonly pairing: StoredPairing }
  | { readonly kind: "proving"; readonly pairing: StoredPairing }
  | { readonly kind: "live"; readonly pairing: StoredPairing }
  /** Closing by its own choice: another environment answered. */
  | { readonly kind: "leaving" };

interface Connection {
  readonly socket: WebSocket;
  readonly port: number;
  phase: Phase;
  /** Set once the socket is held: stops its pings. */
  stopPings?: () => void;
  /** Set when the pairing is gone: settles once it is forgotten, after which the worker announces again at once. */
  forgetting?: Promise<void>;
  /** Set when the opening was refused, so the close keeps the refusal's status. */
  refused?: boolean;
  /** Set when the port to dial changed: the close dials again at once. */
  redial?: boolean;
}

export const startWorker = ({ chrome, readOwnFile, clock }: WorkerSeams): RunningWorker => {
  const manifest = chrome.runtime.getManifest();
  // What the environment compares with its folder's: the version name, the harness version.
  const extensionVersion = manifest.version_name ?? manifest.version;
  let connection: Connection | undefined;
  /** An attempt reading its port and pairing, before it has a socket. */
  let preparing = false;
  /** Set when the override changes while an attempt reads it: the attempt reads again. */
  let portChanged = false;
  let cancelRetry: (() => void) | undefined;
  let failures = 0;
  /** Why the last pairing was forgotten, said beside the unpaired status until another pairing. */
  let forgotten: string | undefined;
  let status: WorkerStatus = { state: "starting" };
  let stopped = false;
  /** The page policy the environment sent last, kept after its socket closes for the pages still attached. */
  let policy = NO_POLICY_YET;
  const pages = chromePages({ chrome, policy: () => policy });
  /** Woken when an attempt settles: its socket held, or closed, or no socket opened. */
  const settledWaiters = new Set<() => void>();

  const publish = (next: WorkerStatus): void => {
    status = next;
    void chrome.storage.session.set({ [STATUS_KEY]: next });
  };

  const settled = (): void => {
    for (const waiter of [...settledWaiters]) waiter();
    settledWaiters.clear();
  };

  const send = (to: Connection, message: BridgeFromExtension): void => {
    if (to.socket.readyState === WebSocket.OPEN) to.socket.send(encodeBridgeMessage(message));
  };

  const retryLater = (): void => {
    const delay = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)] ?? RETRY_MS[0];
    failures += 1;
    cancelRetry?.();
    cancelRetry = clock.after(delay, () => {
      cancelRetry = undefined;
      connect();
    });
  };

  /** Dials now, unless a socket is open or being opened. */
  const connect = (): void => {
    if (stopped || connection !== undefined || preparing) return;
    cancelRetry?.();
    cancelRetry = undefined;
    preparing = true;
    void open()
      // Chrome's storage failing to answer: the next attempt reads it again.
      .catch(() => retryLater())
      .finally(() => {
        preparing = false;
      });
  };

  const open = async (): Promise<void> => {
    portChanged = false;
    const [override, reading, pairing, name] = await Promise.all([readPortOverride(chrome), readPortFile(readOwnFile), readPairing(chrome), readName(chrome)]);
    if (stopped) return;
    if (portChanged) return open();
    // The override wins while it is set; else the port file's port, or why there is none.
    const port = override ?? (reading.ok ? reading.file.port : reading.problem);
    if (typeof port === "string") {
      publish({ state: "no-port", problem: port });
      settled();
      return retryLater();
    }
    publish({ state: "connecting", port });
    const opened: Connection = { socket: new WebSocket(bridgeUrl(port)), port, phase: { kind: "dialling" } };
    connection = opened;
    opened.socket.addEventListener("open", () => {
      if (pairing === undefined) {
        opened.phase = { kind: "announcing" };
        send(opened, { type: "announce", protocolVersion: BRIDGE_PROTOCOL_VERSION, extensionVersion, name });
      } else {
        opened.phase = { kind: "hello", pairing };
        send(opened, {
          type: "hello",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          extensionVersion,
          environmentId: pairing.environmentId,
          chromeId: pairing.chromeId,
          name: pairing.name,
        });
      }
    });
    opened.socket.addEventListener("message", (event: MessageEvent) => void onMessage(opened, event.data));
    opened.socket.addEventListener("close", () => void onClose(opened));
    // Chrome follows an error with the close; Node's WebSocket, which the tests run on, does not when the dial fails.
    opened.socket.addEventListener("error", () => void onClose(opened));
  };

  /** The socket is held: announced, proved or paired. Pings start, and the next failure waits the shortest time again. */
  const hold = (held: Connection, next: WorkerStatus): void => {
    failures = 0;
    publish(next);
    if (held.stopPings === undefined) {
      const ping = (): void => {
        send(held, { type: "ping" });
        held.stopPings = clock.after(PING_MS, ping);
      };
      held.stopPings = clock.after(PING_MS, ping);
    }
    settled();
  };

  /** Ends a conversation the environment broke: `refused`, as either side may send, and the close. */
  const refuse = (refusing: Connection, reason: string): void => {
    send(refusing, { type: "refused", reason });
    refusing.socket.close(1000);
  };

  const onRefused = (refused: Connection, reason: string): void => {
    const phase = refused.phase;
    if (phase.kind === "announced" && phase.pair !== undefined) {
      // A refused code keeps the announced socket for the next.
      refused.phase = { kind: "announced", environmentId: phase.environmentId, environmentName: phase.environmentName };
      return phase.pair.answer({ ok: false, reason });
    }
    if (phase.kind === "proving" || phase.kind === "live") {
      forgotten = reason;
      refused.forgetting = chrome.storage.local.remove(PAIRING_KEY);
    } else {
      // The opening was refused: the pairing, if one is held, stands.
      refused.refused = true;
      publish({ state: "refused", port: refused.port, reason });
    }
    refused.socket.close(1000);
  };

  const onMessage = async (on: Connection, data: unknown): Promise<void> => {
    if (typeof data !== "string") return refuse(on, "The bridge carries JSON text, one message a frame, never binary.");
    const decoded = decodeFromEnvironment(data);
    if (!decoded.ok) return refuse(on, decoded.reason);
    const message = decoded.message;
    const phase = on.phase;
    const outOfTurn = () => refuse(on, `The extension did not expect ${message.type} here.`);
    switch (message.type) {
      case "ping":
        return send(on, { type: "pong" });
      case "pong":
        return;
      case "announced":
        if (phase.kind !== "announcing") return outOfTurn();
        on.phase = { kind: "announced", environmentId: message.environmentId, environmentName: message.environmentName };
        return hold(on, { state: "unpaired", port: on.port, environmentName: message.environmentName, ...(forgotten !== undefined && { forgotten }) });
      case "challenge":
        if (phase.kind !== "hello") return outOfTurn();
        if (message.environmentId !== phase.pairing.environmentId) {
          on.phase = { kind: "leaving" };
          publish({ state: "other-environment", port: on.port, pairedWith: phase.pairing.environmentName });
          return on.socket.close(1000);
        }
        on.phase = { kind: "proving", pairing: phase.pairing };
        return send(on, { type: "proof", mac: await proofOf(phase.pairing.secret, message.nonce) });
      case "ready":
        if (phase.kind !== "proving") return outOfTurn();
        on.phase = { kind: "live", pairing: phase.pairing };
        policy = message.policy;
        return hold(on, { state: "connected", port: on.port, environmentName: phase.pairing.environmentName, name: phase.pairing.name });
      case "paired": {
        if (phase.kind !== "announced" || phase.pair === undefined) return outOfTurn();
        const pairing: StoredPairing = {
          chromeId: message.chromeId,
          secret: message.secret,
          environmentId: phase.environmentId,
          environmentName: phase.environmentName,
          name: phase.pair.name,
        };
        on.phase = { kind: "live", pairing };
        policy = message.policy;
        await chrome.storage.local.set({ [PAIRING_KEY]: pairing });
        forgotten = undefined;
        hold(on, { state: "connected", port: on.port, environmentName: pairing.environmentName, name: pairing.name });
        return phase.pair.answer({ ok: true });
      }
      case "refused":
        return onRefused(on, message.reason);
      case "policy":
        if (phase.kind !== "live") return outOfTurn();
        policy = message.policy;
        return;
      case "call": {
        if (phase.kind !== "live") return outOfTurn();
        const { id, pageKey, command, allowance } = message;
        return send(on, { type: "result", id, result: await pages.perform({ pageKey, command, ...(allowance !== undefined && { allowance }) }) });
      }
    }
  };

  const onClose = async (closed: Connection): Promise<void> => {
    if (connection !== closed) return;
    connection = undefined;
    closed.stopPings?.();
    const phase = closed.phase;
    if (phase.kind === "announced" && phase.pair !== undefined) phase.pair.answer({ ok: false, reason: "The environment closed the connection before it answered." });
    settled();
    if (stopped) return;
    if (closed.forgetting !== undefined) {
      // The pairing is gone: announce again at once.
      await closed.forgetting;
      failures = 0;
      return connect();
    }
    if (closed.redial === true) {
      failures = 0;
      return connect();
    }
    if (phase.kind === "dialling") publish({ state: "unreachable", port: closed.port });
    else if (phase.kind !== "leaving" && closed.refused !== true) publish({ state: "connecting", port: closed.port });
    retryLater();
  };

  /** Dials again at once on a port the override changed. */
  const redial = (): void => {
    if (connection === undefined) {
      portChanged = true;
      return connect();
    }
    connection.redial = true;
    connection.socket.close(1000);
  };

  /** The announced socket, dialling first when none is open, and waiting for an attempt under way to settle. */
  const announcedConnection = async (): Promise<Connection | undefined> => {
    if (connection?.phase.kind !== "announced") {
      const settling = new Promise<void>((resolve) => settledWaiters.add(resolve));
      connect();
      await settling;
    }
    return connection?.phase.kind === "announced" ? connection : undefined;
  };

  const pair = async (code: string, name: string): Promise<PairOutcome> => {
    await chrome.storage.local.set({ [NAME_KEY]: name });
    if ((await readPairing(chrome)) !== undefined) return { ok: false, reason: "This Chrome is paired already." };
    const announced = await announcedConnection();
    if (announced === undefined) return { ok: false, reason: `This extension is not connected to an environment. ${describeStatus(status)}` };
    const phase = announced.phase;
    if (phase.kind !== "announced") return { ok: false, reason: `This extension is not connected to an environment. ${describeStatus(status)}` };
    if (phase.pair !== undefined) return { ok: false, reason: "A pairing is under way; wait for its answer." };
    return new Promise<PairOutcome>((answer) => {
      announced.phase = { ...phase, pair: { name, answer } };
      send(announced, { type: "pair", code, name });
    });
  };

  // Chrome delivers the events that wake a worker only to listeners added as its script first runs.
  const onAlarm = (alarm: { readonly name: string }): void => {
    if (alarm.name === CONNECT_ALARM) connect();
  };
  const onPageMessage: MessageListener = (message, _sender, sendResponse) => {
    const request = pageRequestOf(message);
    if (request === undefined) return undefined;
    if (request.type === "connect") {
      connect();
      sendResponse({ ok: true });
      return undefined;
    }
    void pair(request.code, request.name).then(sendResponse);
    return true;
  };
  const onStorageChanged = (changes: Record<string, StorageChange>): void => {
    if (PORT_OVERRIDE_KEY in changes) return redial();
    // The options page forgot the pairing: announce at once. A pairing this worker forgets dials again from its socket's close.
    const pairingChange = changes[PAIRING_KEY];
    if (pairingChange !== undefined && pairingChange.newValue === undefined && connection?.forgetting === undefined) redial();
  };
  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.runtime.onMessage.addListener(onPageMessage);
  chrome.storage.local.onChanged.addListener(onStorageChanged);
  // Created once: creating it again would put its next firing off by its period.
  void chrome.alarms.get(CONNECT_ALARM).then((alarm) => (alarm === undefined ? chrome.alarms.create(CONNECT_ALARM, { periodInMinutes: CONNECT_ALARM_MINUTES }) : undefined));
  publish(status);
  connect();

  return {
    stop() {
      stopped = true;
      cancelRetry?.();
      chrome.alarms.onAlarm.removeListener(onAlarm);
      chrome.runtime.onMessage.removeListener(onPageMessage);
      chrome.storage.local.onChanged.removeListener(onStorageChanged);
      const open = connection;
      connection = undefined;
      open?.stopPings?.();
      open?.socket.close();
    },
  };
};

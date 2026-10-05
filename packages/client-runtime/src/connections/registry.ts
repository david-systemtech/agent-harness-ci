import type { PendingUpdate } from "@agent-harness/contracts";
import {
  ClientSessionCredential,
  commandResponse,
  type DiscoveryDocument,
  type Frame,
  type HelloFrame,
  type ResponseFrame,
} from "@agent-harness/contracts";
import { exchangeGrant, readsGrant, type GrantExchange, type LocalStatus } from "../bootstrap.js";
import { isStoredCredentialUnavailable } from "../credential-unavailable.js";
import { admitHello, checkDiscovery, readDiscovery } from "../discovery.js";
import { uuidv7 } from "../ids.js";
import type { Notices } from "../notices.js";
import { notifyAll, writable, type Observable } from "../observable.js";
import {
  discoveryFailure,
  exchangeCode,
  pairingFailed,
  parsePairingInput,
  type PairingInput,
  type PairingOptions,
  type PairingOutcome,
} from "../pairing.js";
import type { Platform, Timer } from "../platform.js";
import { parseAddress } from "./address.js";
import {
  SocketClosedError,
  authenticate,
  dial,
  type LiveSocket,
  type SocketClosed,
  type Subscribing,
  type SubscriptionMessage,
} from "./connection.js";
import { askOverRoute, answeredByMethod, carriedArtefact, failed, type UpdateEnvironmentOutcome } from "./environment-update.js";
import {
  LOCAL_ENVIRONMENT_DOCUMENT,
  LOCAL_PLACEHOLDER_ID,
  LOCAL_PLACEHOLDER_NAME,
  NO_PREFERENCES,
  PAIRED_CONNECTIONS_DOCUMENT,
  PREFERENCE_KEYS,
  emptyDescriptor,
  readPairedConnections,
  readPreferences,
  readRememberedLocal,
  writePairedConnections,
  type ClientPreferences,
  type ConnectionCredential,
  type ConnectionRecord,
  type EnvironmentDescriptor,
  type RemoveResult,
  type SavedConnection,
} from "./records.js";
import { createRunner, type Runner, type RunnerHost } from "./runner.js";
import { actionOf, initialMachine, type DiscoveryAnswer, type RefreshOutcome } from "./state-machine.js";

/**
 * The connection registry (docs/specs/client-runtime.md, "The connection
 * registry"): every connection by environment id, the client-local
 * preferences, and the in-process `connections.*` API. Each connection has
 * one runner of the connection state machine (`runner.ts`,
 * `state-machine.ts`), which owns its socket and its retries; the registry
 * is the runner's host: discovery and the grant exchange, the token, the
 * record, the notices.
 */

export type { ConnectionCredential, RemoveResult } from "./records.js";

/** The in-process API, `connections.*`. None of these is a wire method. */
export interface Connections {
  /** Every known connection, in the saved sequence: the first is the primary environment. */
  readonly list: Observable<readonly ConnectionRecord[]>;
  /** Pairs from a link, its QR text, or an address and code; see `PairingOutcome`. */
  add(input: PairingInput, options?: PairingOptions): Promise<PairingOutcome>;
  /** Moves a connection to another address, and reconnects it if enabled. */
  setAddress(environmentId: string, address: string): Promise<void>;
  /** Disabling drops the socket and keeps everything else; enabling connects. */
  setEnabled(environmentId: string, enabled: boolean): Promise<void>;
  /** Puts the known environments in this sequence; it must name each exactly once. */
  setOrder(environmentIds: readonly string[]): Promise<void>;
  /** Notes the environment last used, for the default-environment rule (ADR 0005). */
  setLastUsed(environmentId: string): Promise<void>;
  /**
   * Revokes the connection's client session (over its socket, or a one-off
   * connection when it is disabled or not connected), then forgets the
   * token, the record and what hangs off it. Says whether the revoke happened.
   */
  remove(environmentId: string): Promise<RemoveResult>;
  /**
   * Makes the connection's attempt again now, whatever its phase but
   * `disabled`: the local grant exchange if it is due, discovery, `auth`,
   * `hello`. A block is re-checked against discovery. Settles once the
   * attempt has.
   */
  retryNow(environmentId: string): Promise<void>;
  /**
   * The `service.start` action: starts the local environment's service
   * through the platform shell's `service.start`, then reconnects. Rejects
   * when the connection is not the local one, or the platform has no shell
   * `service` (the terminal UI runs the CLI's `service start` itself, then
   * `retryNow`).
   */
  startService(environmentId: string): Promise<void>;
  /**
   * The `update-environment` action: asks the environment to update itself
   * to this client's version, under the idle rules, and answers the update
   * it took or why not. A connection blocked `protocol-mismatch`, which the
   * wire refuses, asks over `POST /api/update` with its client session's
   * token (and, to the local environment from a desktop that carries the
   * server of that version, the server's path, for the environment to stage
   * rather than download) and then shows `updating` through the
   * environment's restart until `hello` agrees and clears the block; any
   * other sends `updates.apply` on its socket, and follows the
   * `bye: updating` the restart brings. An
   * environment that refuses raises the notice `update-refused` naming why.
   * Rejects for an unknown environment.
   */
  updateEnvironment(environmentId: string): Promise<UpdateEnvironmentOutcome>;
  /** Advance a local update held only by its idle window, even across a protocol gap. */
  updateEnvironmentNow(environmentId: string): Promise<void>;
  /**
   * The connection's address and the token its client session holds now,
   * for a caller that authenticates as this client on the environment's
   * HTTP routes (the terminal UI's printing, ADR 0015's completions): read
   * from where the connection keeps it, minting and saving nothing.
   * Undefined for an environment with no connection, or one that holds no
   * token (a local connection whose grant was never exchanged, a token
   * cleared by a revoke).
   */
  credential(environmentId: string): Promise<ConnectionCredential | undefined>;
}

/** Where the rest of the runtime attaches to connections: #127's subscriptions, #128's outbox. Internal: never on `Runtime`. */
export interface ConnectionSeams {
  /** Every frame after `hello` on any connection, with its environment. */
  onFrame(listener: (environmentId: string, frame: Frame) => void): () => void;
  /**
   * A ready socket is gone for a reason this runtime did not choose: the
   * environment or the network closed it, or the watchdog or a failed probe
   * gave it up as dead. Not heard for `retryNow`, an address edit, disabling,
   * removing or closing.
   */
  onClose(listener: (environmentId: string, closed: SocketClosed) => void): () => void;
  /** An environment was removed: drop its caches, cursors and outbox. Awaited before `remove` settles. */
  onForget(listener: (environmentId: string) => void | Promise<void>): () => void;
  /** A request on the environment's ready socket; rejects when there is none. */
  request(environmentId: string, method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
  /**
   * A socket said a `hello` the connection admitted: it is the connection's
   * ready socket now, and what hangs off it attaches (#127's subscriptions).
   * Heard before the connection publishes `ready`, so a listener that sets
   * `syncing` is never seen `ready` first.
   */
  onReady(listener: (environmentId: string, hello: HelloFrame) => void): () => void;
  /** A subscription on the environment's ready socket (`LiveSocket.subscribe`); rejects with `NotConnectedError` when there is none. */
  subscribe(
    environmentId: string,
    method: string,
    params: Record<string, unknown>,
    listener: (message: SubscriptionMessage) => void,
  ): Promise<Subscribing>;
  /** Ends a subscription on the environment's socket, if it still has that socket. */
  unsubscribe(environmentId: string, subscription: string): void;
  /**
   * The session list is catching up on a ready socket: the connection shows
   * `syncing` instead of `ready` until it is not, and `start`, `add`,
   * `retryNow`, `setAddress`, `setEnabled` and `startService` settle once it
   * is not. Cleared on its own when the socket goes.
   */
  setSyncing(environmentId: string, syncing: boolean): void;
  /**
   * The environment's name, icon or colour, as its own stream's snapshot or
   * notices say them (#323): the descriptor takes them and is saved, and
   * nothing is raised, since another client's rename is no news to show.
   */
  describe(environmentId: string, look: DescribedLook): void;
}

/** What an environment's own stream says of its look: any of its name, icon and colour. */
export type DescribedLook = Partial<Pick<EnvironmentDescriptor, "name" | "icon" | "colour">>;

/** What the cache (#127) tells the registry: read it before connections start, and whether an environment has anything cached. */
export interface RegistryCaches {
  /** Reads what is cached for these environments; the registry awaits it before any connection starts. */
  load(environmentIds: readonly string[]): Promise<void>;
  /** Whether the environment's session list is cached (a cursor on record), so it is unreachable from the start until it is reached. */
  has(environmentId: string): boolean;
}

const NO_CACHES: RegistryCaches = { load: async () => undefined, has: () => false };

/** A subscription asked of an environment with no ready socket. */
export class NotConnectedError extends Error {
  constructor(environmentId: string) {
    super(`Environment ${environmentId} is not connected.`);
    this.name = "NotConnectedError";
  }
}

export interface Registry extends Connections {
  readonly preferences: Observable<ClientPreferences>;
  readonly notices: Notices;
  readonly local: Observable<LocalStatus>;
  readonly seams: ConnectionSeams;
  /** One connection's record. */
  record(environmentId: string): ConnectionRecord | undefined;
  /** Notes in `hiddenDirectories` that the environment's directory at `path` is hidden as of its last use `lastUsedAt`. */
  hideDirectory(environmentId: string, path: string, lastUsedAt: string): Promise<void>;
  /** Reads the saved connections and preferences, exchanges the local grant, and starts every connection's machine; settles once each first attempt has. */
  start(): Promise<void>;
  close(): void;
}

/** How long a revoke waits for its answer before the connection is forgotten anyway. A chosen default. */
export const REVOKE_TIMEOUT_MS = 10_000;

interface Entry {
  updatePending?: PendingUpdate | null;
  updateError?: string | null;
  updateRestarting?: boolean;
  updatePoll?: Timer;
  updateGeneration?: number;
  saved: SavedConnection;
  /** The connection's state machine and the one owner of its socket, timers and retries. */
  readonly runner: Runner;
  /** A local connection's token, held in memory only: it lives as long as the record, which is never saved. */
  token: string | undefined;
  /** What the first discovery read answers without reading: what the placeholder learned, handed to the entry that replaced it. */
  pending?: DiscoveryAnswer | undefined;
  /** The placeholder was replaced: the environment's entry, once it has begun; who waited on the placeholder waits on it. */
  successor?: { readonly environmentId: string; readonly begun: Promise<Entry | undefined> };
}

const unknownEnvironment = (environmentId: string) => new Error(`There is no saved connection to environment ${environmentId}.`);

const notYetSeen = () => new Error("This machine's local environment has not answered yet: its address comes from its grant, and it is not an environment to use until it answers.");

/** The descriptor as a discovery document has it: an environment from before icons and colours (#323) sends neither. */
const fromDiscovery = (descriptor: EnvironmentDescriptor, document: DiscoveryDocument): EnvironmentDescriptor => ({
  ...descriptor,
  name: document.environmentName,
  icon: document.environmentIcon ?? null,
  colour: document.environmentColour ?? null,
  harnessVersion: document.harnessVersion,
  protocolVersion: document.protocolVersion,
  capabilities: [...document.capabilities],
});

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** A refresh's response: the receipt, and the fresh credential when the refresh applied. */
const RefreshResponse = commandResponse(ClientSessionCredential);

/** Whether a revoke's response says the client session is revoked: accepted, or rejected as unknown. */
const revokedBy = (response: ResponseFrame): boolean => {
  const receipt = (response.result as { receipt?: { status?: unknown; reason?: unknown } } | undefined)?.receipt;
  return receipt?.status === "accepted" || (receipt?.status === "rejected" && receipt.reason === "not_found");
};

export const createRegistry = (platform: Platform, protocolVersion: number, notices: Notices, caches: RegistryCaches = NO_CACHES): Registry => {
  const entries = new Map<string, Entry>();
  // A fault with no caller to take it: a renderer's listener that threw, a background write that failed.
  const report = (error: unknown): void => (platform.reportError ? platform.reportError(error) : void Promise.reject(error));
  const prefs = writable<ClientPreferences>(NO_PREFERENCES, report);
  const list = writable<readonly ConnectionRecord[]>([], report);
  const local = writable<LocalStatus>({ state: "none" }, report);
  const frameListeners = new Set<(environmentId: string, frame: Frame) => void>();
  const closeListeners = new Set<(environmentId: string, closed: SocketClosed) => void>();
  const forgetListeners = new Set<(environmentId: string) => void | Promise<void>>();
  const readyListeners = new Set<(environmentId: string, hello: HelloFrame) => void>();
  /** The environments whose session list is catching up on a ready socket, and who waits for it to finish. */
  const syncing = new Map<string, (() => void)[]>();
  let closed = false;
  let stopNetwork: (() => void) | undefined;
  // Writes go one after another, so an older write never lands over a newer one.
  let writes: Promise<void> = Promise.resolve();

  const isEnabled = (environmentId: string) => prefs.read()["environments.enabled"][environmentId] !== false;

  const toRecord = (environmentId: string, entry: Entry): ConnectionRecord => {
    const machine = entry.runner.state;
    return {
      environmentId,
      ...entry.saved,
      // A reason shows only beside `blocked`; a disabled connection keeps its block to re-check once enabled.
      blocked: machine.phase === "blocked" ? machine.blocked : null,
      enabled: isEnabled(environmentId),
      // The machine says the socket is good; `syncing` is the session list catching up on it (#127).
      phase: machine.phase === "ready" && syncing.has(environmentId) ? "syncing" : machine.phase,
      bye: machine.bye,
      retryAt: iso(machine.retryAt),
      unreachableSince: iso(machine.unreachableSince),
      refreshFailed: machine.refreshFailed,
      action: actionOf(machine),
      ...(machine.updateDeadline !== null && { update: {
        pending: entry.updatePending ?? null,
        error: entry.updateError ?? null,
        restarting: entry.updateRestarting ?? false,
        canUpdateNow: !entry.updateRestarting && entry.saved.kind === "local" && platform.shell?.service?.applyUpdateNow !== undefined && idleHold(entry.updatePending),
      } }),
    };
  };

  /** The known connections in the saved sequence; any the sequence does not name follow, in the order they became known. */
  const publish = () => {
    const sequence = prefs.read()["environments.sequence"];
    const rank = (id: string) => {
      // The placeholder is where the local environment will be: first. It never enters the saved sequence.
      if (id === LOCAL_PLACEHOLDER_ID) return -1;
      const at = sequence.indexOf(id);
      return at === -1 ? sequence.length : at;
    };
    const ids = [...entries.keys()].sort((a, b) => rank(a) - rank(b));
    list.set(ids.map((id) => toRecord(id, entries.get(id) as Entry)));
  };

  const idleHold = (pending: PendingUpdate | null | undefined): boolean => pending?.state === "waiting" &&
    (pending.waitsOn === null || pending.waitsOn.reason === "recent-activity" || pending.waitsOn.reason === "parked-prompt");

  const pollUpdate = async (environmentId: string, entry: Entry): Promise<void> => {
    const read = platform.shell?.service?.pendingUpdate;
    if (!read || entry.saved.kind !== "local" || !isCurrent(environmentId, entry) || entry.runner.state.updateDeadline === null) return;
    const generation = entry.updateGeneration ?? 0;
    try {
      const pending = await read();
      if (!isCurrent(environmentId, entry) || entry.runner.state.updateDeadline === null || generation !== (entry.updateGeneration ?? 0)) return;
      entry.updatePending = pending;
      entry.updateError = null;
      entry.updateRestarting = pending.state === "draining" || pending.state === "switching";
    } catch (error) {
      if (!isCurrent(environmentId, entry) || entry.runner.state.updateDeadline === null || generation !== (entry.updateGeneration ?? 0)) return;
      entry.updatePending = null;
      entry.updateError = error instanceof Error ? error.message : String(error);
    }
    publish();
    if (isCurrent(environmentId, entry) && entry.runner.state.updateDeadline !== null) {
      entry.updatePoll = platform.clock.setTimeout(() => { void pollUpdate(environmentId, entry); }, 5000);
    }
  };

  const entryOf = (environmentId: string): Entry => {
    const entry = entries.get(environmentId);
    if (!entry) throw unknownEnvironment(environmentId);
    return entry;
  };

  const enqueue = (write: () => Promise<void>): Promise<void> => {
    writes = writes.then(write, write);
    return writes;
  };

  // Only paired entries: `writePairedConnections` filters by kind too, so a local entry never reaches the document either way.
  const savePaired = () =>
    enqueue(() =>
      platform.documents.set(
        PAIRED_CONNECTIONS_DOCUMENT,
        writePairedConnections([...entries].filter(([, entry]) => entry.saved.kind === "paired").map(([id, entry]) => [id, entry.saved])),
      ),
    );

  /** The local environment's identity, so it stays listed while its service is down. Never its token or client session. */
  const rememberLocal = (environmentId: string, saved: SavedConnection) =>
    // The placeholder is nothing seen: it is never remembered.
    environmentId === LOCAL_PLACEHOLDER_ID
      ? Promise.resolve()
      : enqueue(() => platform.documents.set(LOCAL_ENVIRONMENT_DOCUMENT, { environmentId, address: saved.address, descriptor: saved.descriptor }));

  const setPreferences = (change: (current: ClientPreferences) => ClientPreferences) => {
    prefs.update(change);
    publish();
    const now = prefs.read();
    return enqueue(async () => {
      for (const key of PREFERENCE_KEYS) await platform.documents.set(key, now[key]);
    });
  };

  /** Puts a newly known environment into the sequence: first (the local one) or last (a paired one). */
  const enterSequence = async (environmentId: string, at: "first" | "last") => {
    const sequence = prefs.read()["environments.sequence"];
    if (sequence.includes(environmentId)) return publish();
    await setPreferences((p) => ({ ...p, "environments.sequence": at === "first" ? [environmentId, ...sequence] : [...sequence, environmentId] }));
  };

  const updateSaved = async (environmentId: string, entry: Entry, change: Partial<SavedConnection>) => {
    entry.saved = { ...entry.saved, ...change };
    if (entries.get(environmentId) !== entry) return;
    publish();
    await (entry.saved.kind === "paired" ? savePaired() : rememberLocal(environmentId, entry.saved));
  };

  const isCurrent = (environmentId: string, entry: Entry) => entries.get(environmentId) === entry && !closed;

  /** The list is no longer catching up: whoever waits on it goes on. Answers whether it was. */
  const endSyncing = (environmentId: string): boolean => {
    const waiting = syncing.get(environmentId);
    if (!waiting) return false;
    syncing.delete(environmentId);
    for (const resolve of waiting) resolve();
    return true;
  };

  /** Settles once the attempt under way has, and the session list it attached is no longer catching up. */
  const settledFor = async (environmentId: string, entry: Entry): Promise<void> => {
    await entry.runner.settled();
    if (entry.successor) {
      const { environmentId: id } = entry.successor;
      const next = await entry.successor.begun;
      return next ? settledFor(id, next) : undefined;
    }
    const waiting = syncing.get(environmentId);
    if (!waiting || entry.runner.state.step !== "open") return;
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  /**
   * Revokes `clientSessionId` with `token`, over `socket` when one is given,
   * else over a one-off connection that is closed after. Best effort: the
   * answer, a close, or `REVOKE_TIMEOUT_MS` ends the wait. Resolves whether
   * the environment revoked it. Once the wait has ended the attempt is
   * aborted: it checks after each await, sends nothing more, and closes a
   * one-off socket that opens late.
   */
  const revokeClientSession = async (target: {
    readonly environmentId: string;
    readonly origin: string;
    readonly token: string;
    readonly clientSessionId: string;
    readonly socket?: LiveSocket | undefined;
  }): Promise<boolean> => {
    let oneOff: LiveSocket | undefined;
    let timer: Timer | undefined;
    let aborted = false;
    const attempt = async (): Promise<boolean> => {
      let socket = target.socket;
      if (!socket) {
        const discovery = await readDiscovery(platform.fetch, target.origin);
        if (aborted || !discovery.ok || !checkDiscovery(discovery.document, { protocolVersion, environmentId: target.environmentId }).ok) {
          return false;
        }
        const answer = await authenticate({ webSocket: platform.webSocket, origin: target.origin, token: target.token, client: platform.client, protocolVersion });
        if (!answer.ok) return false;
        if (aborted) {
          answer.socket.close();
          return false;
        }
        oneOff = socket = answer.socket;
        if (admitHello(socket.hello, target.environmentId, protocolVersion)) return false;
      }
      if (aborted) return false;
      try {
        return revokedBy(await socket.request("access.sessions.revoke", { commandId: uuidv7(platform.clock.now()), clientSessionId: target.clientSessionId }));
      } catch (error) {
        // Revoking the caller's own client session closes its socket with `bye: revoked`, which may come before the answer.
        return error instanceof SocketClosedError && error.closed.bye?.reason === "revoked";
      }
    };
    const timeout = new Promise<boolean>((resolve) => (timer = platform.clock.setTimeout(() => resolve(false), REVOKE_TIMEOUT_MS)));
    try {
      return await Promise.race([attempt(), timeout]);
    } finally {
      aborted = true;
      timer?.cancel();
      oneOff?.close();
    }
  };

  /** Exchanges the local grant for this entry: its token and client session kept, or what the failure was. */
  const exchangeLocal = async (environmentId: string, entry: Entry): Promise<DiscoveryAnswer> => {
    const exchange = await exchangeGrant({ fetch: platform.fetch, grant: platform.grant, client: platform.client, protocolVersion });
    if (!isCurrent(environmentId, entry)) return { kind: "unreachable", message: "The connection was forgotten." };
    const answer = answerOf(exchange);
    if (!exchange.ok) local.set(exchange.status);
    if (environmentId === LOCAL_PLACEHOLDER_ID) {
      promote(entry, exchange, answer);
      return answer;
    }
    if (!exchange.ok) return answer;
    // A grant that is now another environment's: discovery's check blocks it `different-environment`, and the next start takes that one as the local environment.
    if (exchange.discovery.environmentId !== environmentId) return { kind: "document", document: exchange.discovery };
    await keepExchanged(environmentId, entry, exchange);
    return { kind: "document", document: exchange.discovery };
  };

  /** Keeps what the grant exchange for `entry` gave: its token in memory, its client session and address on the record. */
  const keepExchanged = async (environmentId: string, entry: Entry, exchange: Extract<GrantExchange, { ok: true }>): Promise<void> => {
    entry.token = exchange.credential.token;
    local.set({ state: "exchanged", environmentId });
    await updateSaved(environmentId, entry, {
      address: exchange.origin,
      clientSessionId: exchange.credential.clientSessionId,
      scopes: [...exchange.credential.scopes],
      ceiling: exchange.credential.ceiling,
      expiresAt: exchange.credential.expiresAt,
    });
  };

  /**
   * The token `update-environment` posts the update route with: the
   * connection's own; else, for a local connection that holds none (blocked
   * on an older protocol since its first discovery, so the start's exchange
   * refused before sending the secret), the grant exchanged now across the
   * gap and kept as an exchange's token is (#826). A failed exchange says so
   * in the local environment's words, which never ask to pair it.
   */
  const routeToken = async (
    environmentId: string,
    entry: Entry,
    name: string,
  ): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly outcome: UpdateEnvironmentOutcome }> => {
    const held = await tokenOf(environmentId, entry);
    if (held !== undefined) return { ok: true, token: held };
    if (entry.saved.kind !== "local") return { ok: false, outcome: failed("no-token", `This client holds no token for ${name}: pair it again.`) };
    const exchange = await exchangeGrant({ fetch: platform.fetch, grant: platform.grant, client: platform.client, protocolVersion, acrossProtocolGap: true });
    if (!isCurrent(environmentId, entry)) return { ok: false, outcome: failed("no-token", "The connection was forgotten.") };
    if (!exchange.ok) {
      local.set(exchange.status);
      const why = exchange.status.state === "failed" ? exchange.status.message : "This client reads no grant.";
      return { ok: false, outcome: failed("no-token", `This client could not exchange the local grant with ${name}: ${why}`) };
    }
    if (exchange.discovery.environmentId !== environmentId) {
      const other = exchange.discovery.environmentName;
      return { ok: false, outcome: failed("no-token", `This machine's grant now names ${other}, not ${name}: the next start takes ${other} as the local environment.`) };
    }
    await keepExchanged(environmentId, entry, exchange);
    return { ok: true, token: exchange.credential.token };
  };

  /** What a grant exchange is to the connection's machine: the discovery document it read, or the failure in the phases' words. */
  const answerOf = (exchange: GrantExchange): DiscoveryAnswer => {
    if (exchange.ok) return { kind: "document", document: exchange.discovery };
    const status = exchange.status;
    return status.state === "failed"
      ? { kind: "grant-failed", reason: status.reason, message: status.message }
      : { kind: "grant-failed", reason: "service-down", message: "This client reads no grant." };
  };

  /**
   * The local environment known from its discovery document alone (the
   * exchange failed after it answered): listed and remembered under its id,
   * with no client session yet; its machine exchanges the grant on its next attempt.
   */
  const seenLocal = async (origin: string, document: DiscoveryDocument, failures = 0): Promise<Entry> => {
    const id = document.environmentId;
    const saved: SavedConnection = {
      address: origin,
      kind: "local",
      clientSessionId: null,
      scopes: [],
      ceiling: null,
      descriptor: fromDiscovery(emptyDescriptor(document.environmentName), document),
      blocked: null,
      expiresAt: null,
    };
    const entry = newEntry(id, saved, undefined, failures);
    entries.set(id, entry);
    // In the sequence before any write is awaited, so the list that first shows it shows it first.
    const entering = enterSequence(id, "first");
    // Awaited below; marked handled here so a write failing first leaves no unhandled rejection behind.
    entering.catch(() => undefined);
    await rememberLocal(id, saved);
    await entering;
    return entry;
  };

  /**
   * The placeholder's grant exchange named the environment: its own entry
   * takes the placeholder's place, carrying the machine's failure count, and
   * begins with what the exchange learned as its first discovery answer (the
   * document, with the client session kept; or the failure, which the new
   * machine waits out on the ladder from where the placeholder's was). A
   * failure that named nothing leaves the placeholder, and so does one that
   * names an environment already listed (a paired connection to this
   * machine), until an exchange succeeds and replaces that as a start would.
   */
  const promote = (placeholder: Entry, exchange: GrantExchange, answer: DiscoveryAnswer): void => {
    const document = exchange.discovery;
    if (!document || (!exchange.ok && entries.has(document.environmentId))) return;
    const id = document.environmentId;
    const failures = placeholder.runner.state.failures;
    let begun!: (entry: Entry | undefined) => void;
    placeholder.successor = { environmentId: id, begun: new Promise((resolve) => (begun = resolve)) };
    entries.delete(LOCAL_PLACEHOLDER_ID);
    placeholder.runner.stop();
    if (exchange.ok) local.set({ state: "exchanged", environmentId: id });
    // The environment's entry is set before the first write is awaited, so the list goes from the placeholder to it in one step.
    const listing = exchange.ok ? adoptLocal(exchange, failures) : seenLocal(exchange.origin as string, document, failures);
    publish();
    void (async (): Promise<Entry | undefined> => {
      try {
        await listing;
      } catch (error) {
        // A write that failed is reported; the entry is listed all the same.
        report(error);
      }
      const entry = entries.get(id);
      if (!entry || closed) return undefined;
      entry.pending = answer;
      if (prefs.read()["environments.enabled"][LOCAL_PLACEHOLDER_ID] !== undefined) {
        await setPreferences((p) => ({
          ...p,
          "environments.enabled": Object.fromEntries(Object.entries(p["environments.enabled"]).filter(([key]) => key !== LOCAL_PLACEHOLDER_ID)),
        })).catch(report);
      }
      begin(id, entry);
      return entry;
    })().then(begun, (error: unknown) => {
      report(error);
      begun(undefined);
    });
  };

  /** Keeps a refreshed token where this connection's token lives, and its expiry on the record. */
  const refreshOver = async (environmentId: string, entry: Entry, socket: LiveSocket): Promise<RefreshOutcome | undefined> => {
    let response: ResponseFrame;
    try {
      response = await socket.request("access.sessions.refresh", { commandId: uuidv7(platform.clock.now()) });
    } catch (error) {
      // The socket closed first: the machine hears of the close, and the refresh is tried on the next connect.
      if (error instanceof SocketClosedError) return undefined;
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (response.error) return { ok: false, message: response.error.message };
    const answer = RefreshResponse.safeParse(response.result);
    if (!answer.success) return { ok: false, message: "The environment's answer to access.sessions.refresh is not a credential." };
    const { receipt, result } = answer.data;
    if (receipt.status === "rejected") return { ok: false, message: receipt.error.message };
    // A retry answered from its receipt carries no credential; this runtime never retries one, so it is a fault.
    if (!result) return { ok: false, message: "The environment accepted the refresh but sent no credential." };
    if (!isCurrent(environmentId, entry)) return undefined;
    if (entry.saved.kind === "local") entry.token = result.token;
    else await platform.secrets.set(environmentId, result.token);
    await updateSaved(environmentId, entry, { expiresAt: result.expiresAt });
    return { ok: true, expiresAt: Date.parse(result.expiresAt) };
  };

  /** The token a connection sends: a local one's is in memory, a paired one's in the secret store. */
  const tokenOf = async (environmentId: string, entry: Entry): Promise<string | undefined> =>
    entry.saved.kind === "local" ? entry.token : platform.secrets.get(environmentId);

  /** What the runner of `entry` needs of the registry. */
  const hostFor = (environmentId: string, entry: () => Entry): RunnerHost => ({
    clock: platform.clock,
    random: platform.random ?? Math.random,
    async discover() {
      const e = entry();
      const pending = e.pending;
      e.pending = undefined;
      if (pending) return pending;
      if (e.saved.kind === "local" && e.token === undefined) return exchangeLocal(environmentId, e);
      const read = await readDiscovery(platform.fetch, e.saved.address);
      if (read.ok) return { kind: "document", document: read.document };
      // Something answered, but not with a discovery document: not the service being down, a fault the ladder retries.
      return read.kind === "unreachable" ? { kind: "unreachable", message: read.message } : { kind: "malformed", message: read.message };
    },
    token: async () => tokenOf(environmentId, entry()),
    expiresAt: () => {
      const at = entry().saved.expiresAt;
      return at === null ? null : Date.parse(at);
    },
    dial: (token) => dial({ webSocket: platform.webSocket, origin: entry().saved.address, token, client: platform.client, protocolVersion }),
    async attach(socket, document) {
      const e = entry();
      const { hello } = socket;
      // A seam listener that throws is reported, never thrown into the socket's message handler.
      socket.onFrame((frame) => {
        try {
          notifyAll(frameListeners, environmentId, frame);
        } catch (error) {
          report(error);
        }
      });
      // What hangs off the socket attaches at once; a listener's fault is reported and costs the record nothing.
      try {
        notifyAll(readyListeners, environmentId, hello);
      } catch (error) {
        report(error);
      }
      const descriptor = document ? fromDiscovery(e.saved.descriptor, document) : e.saved.descriptor;
      await updateSaved(environmentId, e, {
        clientSessionId: hello.clientSessionId,
        scopes: [...hello.scopes],
        ceiling: hello.ceiling,
        blocked: null,
        descriptor: {
          ...descriptor,
          name: hello.environmentName,
          icon: hello.environmentIcon ?? null,
          colour: hello.environmentColour ?? null,
          protocolVersion: hello.protocolVersion,
          capabilities: [...hello.capabilities],
          lastSeen: platform.clock.now().toISOString(),
        },
      });
    },
    describe: (document) => {
      const e = entry();
      if (e.runner.state.updateDeadline !== null) {
        e.updateRestarting = document.readiness !== "ready" || e.updatePending?.state === "draining" || e.updatePending?.state === "switching";
        if (document.readiness !== "ready") e.updatePending = null;
      }
      return updateSaved(environmentId, e, { descriptor: fromDiscovery(e.saved.descriptor, document) });
    },
    async clearToken() {
      const e = entry();
      if (e.saved.kind === "local") e.token = undefined;
      else if (isCurrent(environmentId, e)) await platform.secrets.delete(environmentId);
    },
    refresh: (socket) => refreshOver(environmentId, entry(), socket),
    notice: (draft) => {
      if (isCurrent(environmentId, entry())) notices.raise(environmentId, draft);
    },
    changed(next, previous) {
      const e = entry();
      if (next.updateDeadline === null) {
        e.updatePoll?.cancel();
        e.updateGeneration = (e.updateGeneration ?? 0) + 1;
        e.updatePending = null;
        e.updateError = null;
        e.updateRestarting = false;
      } else if (next.failures > previous.failures) {
        e.updateRestarting = true;
        e.updatePending = null;
      }
      if (next.step !== "open") endSyncing(environmentId);
      if (!isCurrent(environmentId, e)) return;
      if (next.blocked !== previous.blocked) return updateSaved(environmentId, e, { blocked: next.blocked });
      publish();
    },
    lost: (how) => notifyAll(closeListeners, environmentId, how),
    report,
  });

  /** `failures`: where the machine's ladder stands, carried over from the placeholder it replaces. */
  const newEntry = (environmentId: string, saved: SavedConnection, token?: string, failures = 0): Entry => {
    const machine = {
      ...initialMachine({
        environmentId,
        protocolVersion,
        kind: saved.kind,
        name: saved.descriptor.name,
        blocked: saved.blocked,
        capabilities: saved.descriptor.capabilities,
      }),
      failures,
    };
    const entry: Entry = { saved, token, runner: createRunner(hostFor(environmentId, () => entry), machine) };
    return entry;
  };

  /** Starts `entry`'s machine: an attempt if enabled and online. */
  const begin = (environmentId: string, entry: Entry) =>
    entry.runner.feed({
      type: "start",
      enabled: isEnabled(environmentId),
      network: platform.network.read(),
      // Cached streams are served while the environment is unreachable, so it is unreachable from the start until reached.
      hasCache: caches.has(environmentId),
    });

  /**
   * Revokes the client session `entry` holds with its own token, over its
   * socket when it is ready, else over a one-off connection to `origin`:
   * what `remove` and a re-pair in place say about the session they give up.
   */
  const revokeHeld = async (
    environmentId: string,
    entry: Entry,
    socket: LiveSocket | undefined,
    origin: string = entry.saved.address,
  ): Promise<RemoveResult> => {
    const name = entry.saved.descriptor.name;
    if (!entry.saved.scopes.includes("admin")) {
      return {
        revoked: false,
        reason: "scope",
        message: `This client was paired with ${name} without the admin scope, so its client session there is still live: revoke it from a client that has admin.`,
      };
    }
    let token: string | undefined;
    try { token = await platform.secrets.get(environmentId); }
    catch (error) {
      if (!isStoredCredentialUnavailable(error)) throw error;
      return {
        revoked: false, reason: "unreachable",
        message: `The stored credentials for ${name} could not be read, so this client's session there is still live: revoke it from another client.`,
      };
    }
    const clientSessionId = entry.saved.clientSessionId;
    if (clientSessionId !== null && token !== undefined && (await revokeClientSession({ environmentId, origin, token, clientSessionId, socket }))) {
      return { revoked: true };
    }
    return {
      revoked: false,
      reason: "unreachable",
      message: `${name} could not be reached, so this client's session there is still live: revoke it from another client.`,
    };
  };

  /** Takes the placeholder out: the local environment is listed under its own id now. */
  const dropPlaceholder = () => {
    const placeholder = entries.get(LOCAL_PLACEHOLDER_ID);
    if (!placeholder) return;
    entries.delete(LOCAL_PLACEHOLDER_ID);
    placeholder.runner.stop();
  };

  /**
   * Takes the local connection from a grant exchange. A paired connection to
   * the same environment is replaced: its client session is revoked with the
   * new local one (which holds every scope), then its record and token are
   * forgotten.
   */
  const adoptLocal = async (exchange: Extract<GrantExchange, { ok: true }>, failures = 0) => {
    const id = exchange.discovery.environmentId;
    // A placeholder from an earlier start that failed gives way; `promote` has taken it out already.
    dropPlaceholder();
    const previous = entries.get(id);
    previous?.runner.stop();
    if (previous?.saved.kind === "paired") {
      // The local grant already supplied an admin token. Reading the earlier
      // paired token here would make local bootstrap wait on OS approval.
      if (previous.saved.clientSessionId !== null) {
        await revokeClientSession({ environmentId: id, origin: exchange.origin, token: exchange.credential.token, clientSessionId: previous.saved.clientSessionId });
      }
      await platform.secrets.delete(id);
    }
    const saved: SavedConnection = {
      address: exchange.origin,
      kind: "local",
      clientSessionId: exchange.credential.clientSessionId,
      scopes: [...exchange.credential.scopes],
      ceiling: exchange.credential.ceiling,
      descriptor: fromDiscovery(previous?.saved.descriptor ?? emptyDescriptor(exchange.discovery.environmentName), exchange.discovery),
      blocked: null,
      expiresAt: exchange.credential.expiresAt,
    };
    entries.set(id, newEntry(id, saved, exchange.credential.token, failures));
    // In the sequence before any write is awaited, so the list that first shows it shows it first; one already there keeps its place.
    const entering = enterSequence(id, "first");
    // Awaited below; marked handled here so a write failing first leaves no unhandled rejection behind.
    entering.catch(() => undefined);
    if (previous?.saved.kind === "paired") await savePaired();
    await rememberLocal(id, saved);
    await entering;
  };

  /**
   * Reads the saved connections and preferences, once: `start` and every
   * mutating call await it, so a call before `start` never saves an empty
   * view over what was saved, and a `start` retried after a failure keeps its
   * entries (whose sockets its attempts drop) instead of orphaning them.
   * A read that fails is read again next time.
   */
  let loading: Promise<{ readonly remembered: unknown }> | undefined;
  // Once loaded, a call goes on without awaiting, so what it does at once (a retry's `connecting`) is seen at once.
  let loaded = false;
  const ensureLoaded = () =>
    (loading ??= (async () => {
      const [paired, remembered, stored] = await Promise.all([
        platform.documents.get(PAIRED_CONNECTIONS_DOCUMENT),
        platform.documents.get(LOCAL_ENVIRONMENT_DOCUMENT),
        Promise.all(PREFERENCE_KEYS.map(async (key) => [key, await platform.documents.get(key)] as const)),
      ]);
      prefs.set(readPreferences(Object.fromEntries(stored) as Record<keyof ClientPreferences, unknown>));
      for (const [id, saved] of readPairedConnections(paired)) if (!entries.has(id)) entries.set(id, newEntry(id, saved));
      // The caches of every environment known, before any connection starts: a cache that cannot be read is reported and counts as empty.
      const known = readRememberedLocal(remembered);
      try {
        await caches.load([...entries.keys(), ...(known ? [known.environmentId] : [])]);
      } catch (error) {
        report(error);
      }
      publish();
      loaded = true;
      return { remembered };
    })().catch((error: unknown) => {
      loading = undefined;
      throw error;
    }));

  const registry: Registry = {
    list,
    preferences: prefs,
    local,
    notices,
    seams: {
      onFrame(listener) {
        frameListeners.add(listener);
        return () => void frameListeners.delete(listener);
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => void closeListeners.delete(listener);
      },
      onForget(listener) {
        forgetListeners.add(listener);
        return () => void forgetListeners.delete(listener);
      },
      request(environmentId, method, params) {
        const socket = entries.get(environmentId)?.runner.socket();
        if (!socket) return Promise.reject(new NotConnectedError(environmentId));
        return socket.request(method, params);
      },
      onReady(listener) {
        readyListeners.add(listener);
        return () => void readyListeners.delete(listener);
      },
      subscribe(environmentId, method, params, listener) {
        const socket = entries.get(environmentId)?.runner.socket();
        if (!socket) return Promise.reject(new NotConnectedError(environmentId));
        // A subscriber that throws is reported, never thrown into the socket's message handler, as the other seams' listeners are.
        return socket.subscribe(method, params, (message) => {
          try {
            listener(message);
          } catch (error) {
            report(error);
          }
        });
      },
      unsubscribe(environmentId, subscription) {
        entries.get(environmentId)?.runner.socket()?.unsubscribe(subscription);
      },
      setSyncing(environmentId, on) {
        const entry = entries.get(environmentId);
        let changed = false;
        if (!on) changed = endSyncing(environmentId);
        else if (!syncing.has(environmentId) && entry?.runner.state.step === "open") {
          syncing.set(environmentId, []);
          changed = true;
        }
        if (changed && entry && isCurrent(environmentId, entry)) publish();
      },
      describe(environmentId, look) {
        const entry = entries.get(environmentId);
        if (!entry || !isCurrent(environmentId, entry)) return;
        const { descriptor } = entry.saved;
        if ((Object.keys(look) as (keyof DescribedLook)[]).every((field) => look[field] === descriptor[field])) return;
        updateSaved(environmentId, entry, { descriptor: { ...descriptor, ...look } }).catch(report);
      },
    },

    record(environmentId) {
      const entry = entries.get(environmentId);
      return entry && toRecord(environmentId, entry);
    },

    async start() {
      const { remembered } = await ensureLoaded();

      if (readsGrant(platform.grant, platform.client)) {
        const exchange = await exchangeGrant({ fetch: platform.fetch, grant: platform.grant, client: platform.client, protocolVersion });
        if (exchange.ok) {
          await adoptLocal(exchange);
          local.set({ state: "exchanged", environmentId: exchange.discovery.environmentId });
        } else {
          local.set(exchange.status);
          // The local environment stays listed from what was remembered of it; its machine tries the grant again on the ladder.
          const known = readRememberedLocal(remembered);
          const listed = [...entries.values()].some((entry) => entry.saved.kind === "local");
          if (!known && !listed && exchange.status.state === "failed") {
            // Never seen: under its own id when its discovery document named it, else as the placeholder, until it answers.
            const document = exchange.discovery;
            if (document && !entries.has(document.environmentId)) await seenLocal(exchange.origin as string, document);
            else if (!document) {
              const placeholder: SavedConnection = {
                address: exchange.origin ?? "",
                kind: "local",
                clientSessionId: null,
                scopes: [],
                ceiling: null,
                descriptor: emptyDescriptor(LOCAL_PLACEHOLDER_NAME),
                blocked: null,
                expiresAt: null,
              };
              entries.set(LOCAL_PLACEHOLDER_ID, newEntry(LOCAL_PLACEHOLDER_ID, placeholder));
              publish();
            }
          }
          if (known && !entries.has(known.environmentId) && exchange.status.state === "failed") {
            const saved: SavedConnection = {
              address: known.address,
              kind: "local",
              clientSessionId: null,
              scopes: [],
              ceiling: null,
              descriptor: known.descriptor,
              blocked: null,
              expiresAt: null,
            };
            entries.set(known.environmentId, newEntry(known.environmentId, saved));
            await enterSequence(known.environmentId, "first");
          }
        }
      }
      stopNetwork ??= platform.network.subscribe((network) => {
        for (const entry of entries.values()) entry.runner.feed({ type: "network", network });
      });
      for (const [id, entry] of entries) begin(id, entry);
      await Promise.all([...entries].map(([id, entry]) => settledFor(id, entry)));
    },

    async add(input, options = {}) {
      if (!loaded) await ensureLoaded();
      const parsed = parsePairingInput(input);
      if (!parsed.ok) return { status: "failed", failure: parsed.failure };
      const { origin, code } = parsed;
      if (options.rePair !== undefined) entryOf(options.rePair);

      const discovery = await readDiscovery(platform.fetch, origin);
      if (!discovery.ok) return pairingFailed(discovery.kind, discovery.message);
      const document = discovery.document;
      const check = checkDiscovery(document, { protocolVersion });
      if (!check.ok) return pairingFailed(discoveryFailure(check.reason), check.message);
      const id = document.environmentId;
      if (options.rePair !== undefined && options.rePair !== id) {
        const saved = entries.get(options.rePair)?.saved.descriptor.name ?? options.rePair;
        return pairingFailed("different-environment", `That code is for ${document.environmentName}, not ${saved}.`);
      }
      const existing = entries.get(id);
      if (existing?.saved.kind === "local") {
        return pairingFailed("refused", `${document.environmentName} is this machine's local environment: it connects through its grant, with no code.`);
      }
      if (existing && options.rePair === undefined) {
        return { status: "re-pair-offered", environmentId: id, name: existing.saved.descriptor.name };
      }

      const exchanged = await exchangeCode(platform.fetch, origin, code, platform.client, protocolVersion);
      if (!exchanged.ok) return { status: "failed", failure: exchanged.failure };
      const { credential } = exchanged;

      // The new client session is tried before anything is kept: a `hello` from another environment, or another protocol, keeps nothing.
      const answer = await authenticate({ webSocket: platform.webSocket, origin, token: credential.token, client: platform.client, protocolVersion });
      if (answer.ok) {
        const refusal = admitHello(answer.socket.hello, id, protocolVersion);
        if (refusal) {
          if (answer.socket.hello.scopes.includes("admin")) {
            await revokeClientSession({ environmentId: id, origin, token: credential.token, clientSessionId: credential.clientSessionId, socket: answer.socket });
          }
          answer.socket.close();
          return pairingFailed(refusal.reason, refusal.message);
        }
      }

      // Re-pairing in place gives up the client session the connection held: it is revoked before the new token is kept, over the
      // new connection when the new client session holds `admin`, else with the old token, best effort as removal is.
      let replaced: RemoveResult | undefined;
      // The old socket is the registry's now, and the old machine holds until the new socket is adopted: revoking over either socket
      // closes the old one with a `bye: revoked` that machine must not hear, and nothing may reconnect with the old token meanwhile.
      const held = existing?.runner.detach();
      // Set once the pairing socket belongs to a machine; until then a failure closes it.
      let adopted = false;
      let created: Entry | undefined;
      try {
        if (existing) {
          const previous = existing.saved.clientSessionId;
          if (previous !== null) {
            const viaNew =
              answer.ok &&
              answer.socket.hello.scopes.includes("admin") &&
              (await revokeClientSession({ environmentId: id, origin, token: credential.token, clientSessionId: previous, socket: answer.socket }));
            replaced = viaNew ? { revoked: true } : await revokeHeld(id, existing, held, origin);
          }
          held?.close();
        }

        await platform.secrets.set(id, credential.token);
        const saved: SavedConnection = {
          address: origin,
          kind: "paired",
          clientSessionId: credential.clientSessionId,
          scopes: [...credential.scopes],
          ceiling: credential.ceiling,
          descriptor: fromDiscovery(existing?.saved.descriptor ?? emptyDescriptor(document.environmentName), document),
          blocked: null,
          expiresAt: credential.expiresAt,
        };
        const entry = existing ?? (created = newEntry(id, saved));
        if (existing) {
          await updateSaved(id, existing, saved);
        } else {
          entries.set(id, entry);
          await savePaired();
          await enterSequence(id, "last");
        }
        if (entries.get(id) !== entry || closed) {
          // Removed while this pairing was being kept, or the runtime closed: nothing is attached to a forgotten entry.
          if (answer.ok) answer.socket.close();
          return { status: "paired", environmentId: id, ...(replaced && { replaced }) };
        }
        // A retry, enable, address edit or start that ran while this pairing was being kept did nothing: a re-paired connection's
        // machine holds from `detach` to `adopt`, and a new entry's starts only here. `adopt` and `start` halt first regardless.
        if (answer.ok && isEnabled(id)) {
          // The socket pairing tried is the connection's first one.
          adopted = true;
          entry.runner.adopt(answer.socket, document);
        } else {
          // Closed before `hello`, or disabled: the machine starts from where it is, as at a start.
          if (answer.ok) answer.socket.close();
          entry.runner.resume();
          begin(id, entry);
        }
        // Settled once its session list is no longer catching up, so the caller sees `ready`, not `syncing`.
        await settledFor(id, entry);
        return { status: "paired", environmentId: id, ...(replaced && { replaced }) };
      } catch (error) {
        // The pairing socket nobody took is closed, so the environment is not left holding a second socket.
        if (answer.ok && !adopted) answer.socket.close();
        // What is still listed goes on: the old machine from where it was held, a new one (listed before a write failed) from its
        // start, with the token kept. One forgotten meanwhile (removed, replaced by the local connection) is left stopped.
        const listed = entries.get(id);
        if (listed !== undefined && (listed === existing || listed === created) && !closed) {
          listed.runner.resume();
          begin(id, listed);
        }
        throw error;
      }
    },

    async setAddress(environmentId, address) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      if (environmentId === LOCAL_PLACEHOLDER_ID) throw notYetSeen();
      const origin = parseAddress(address);
      if (!origin) throw new RangeError(`"${address}" is not an address.`);
      await updateSaved(environmentId, entry, { address: origin });
      entry.runner.feed({ type: "retryNow" });
      await settledFor(environmentId, entry);
    },

    async setEnabled(environmentId, enabled) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      await setPreferences((p) => ({ ...p, "environments.enabled": { ...p["environments.enabled"], [environmentId]: enabled } }));
      if (!enabled) return entry.runner.feed({ type: "disable" });
      begin(environmentId, entry);
      await settledFor(environmentId, entry);
    },

    async setOrder(environmentIds) {
      if (!loaded) await ensureLoaded();
      // The placeholder always lists first and is never saved in the sequence: naming it or not is the same.
      const known = new Set([...entries.keys()].filter((id) => id !== LOCAL_PLACEHOLDER_ID));
      environmentIds = environmentIds.filter((id) => id !== LOCAL_PLACEHOLDER_ID);
      const given = new Set(environmentIds);
      if (given.size !== environmentIds.length || given.size !== known.size || [...given].some((id) => !known.has(id))) {
        throw new RangeError("The sequence must name every saved environment exactly once.");
      }
      // The known environments take the places known ones held, in the new sequence; one not known this start keeps its place.
      await setPreferences((p) => {
        const next = [...environmentIds];
        const sequence = p["environments.sequence"].map((id) => (known.has(id) ? (next.shift() as string) : id));
        return { ...p, "environments.sequence": [...sequence, ...next] };
      });
    },

    async setLastUsed(environmentId) {
      if (!loaded) await ensureLoaded();
      entryOf(environmentId);
      if (environmentId === LOCAL_PLACEHOLDER_ID) throw notYetSeen();
      await setPreferences((p) => ({ ...p, "environments.lastUsed": environmentId }));
    },

    async hideDirectory(environmentId, path, lastUsedAt) {
      if (!loaded) await ensureLoaded();
      entryOf(environmentId);
      await setPreferences((p) => ({
        ...p,
        hiddenDirectories: { ...p.hiddenDirectories, [environmentId]: { ...p.hiddenDirectories[environmentId], [path]: lastUsedAt } },
      }));
    },

    async remove(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      if (entry.saved.kind === "local") {
        throw new Error("The local environment's connection comes from its bootstrap grant on every start; disable it instead.");
      }
      // The machine stops before the revoke, which may take up to REVOKE_TIMEOUT_MS: nothing reconnects under it, even when asked.
      const socket = entry.runner.detach();
      entry.runner.stop();
      const result = await revokeHeld(environmentId, entry, socket);
      socket?.close();
      entries.delete(environmentId);
      endSyncing(environmentId);
      await platform.secrets.delete(environmentId);
      await savePaired();
      await setPreferences((p) => ({
        "environments.sequence": p["environments.sequence"].filter((id) => id !== environmentId),
        "environments.enabled": Object.fromEntries(Object.entries(p["environments.enabled"]).filter(([id]) => id !== environmentId)),
        "environments.lastUsed": p["environments.lastUsed"] === environmentId ? null : p["environments.lastUsed"],
        hiddenDirectories: Object.fromEntries(Object.entries(p.hiddenDirectories).filter(([id]) => id !== environmentId)),
      }));
      // Every listener runs even when one fails; what failed is thrown after.
      const failures: unknown[] = [];
      for (const listener of [...forgetListeners]) {
        try {
          await listener(environmentId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `Forgetting environment ${environmentId} failed.`);
      return result;
    },

    async credential(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entries.get(environmentId);
      if (entry === undefined) return undefined;
      const token = await tokenOf(environmentId, entry);
      return token === undefined ? undefined : { origin: entry.saved.address, token };
    },

    async retryNow(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      entry.runner.feed({ type: "retryNow" });
      await settledFor(environmentId, entry);
    },

    async startService(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      if (entry.saved.kind !== "local") throw new Error(`${entry.saved.descriptor.name} is not this machine's local environment: its service is started on its own machine.`);
      const service = platform.shell?.service;
      if (!service) throw new Error("This client cannot start the local environment's service: only the desktop app can; run `agent-harness service start`, then retry.");
      await service.start();
      // A service just started is tried at once and then from the ladder's first rung, not 30 seconds out.
      entry.runner.feed({ type: "retryNow", fresh: true });
      await settledFor(environmentId, entry);
    },

    async updateEnvironment(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      const machine = entry.runner.state;
      const version = platform.client.version;
      const overRoute = machine.phase === "blocked" && machine.blocked === "protocol-mismatch";
      let outcome: UpdateEnvironmentOutcome;
      if (overRoute) {
        const token = await routeToken(environmentId, entry, machine.name);
        if (token.ok) {
          // The local environment stages the server this desktop carries, when it is the version asked, rather than downloading it (#918).
          const artefactPath = entry.saved.kind === "local" ? await carriedArtefact(platform.shell, version) : undefined;
          outcome = typeof artefactPath === "object" ? artefactPath
            : await askOverRoute(platform.fetch, entry.saved.address, token.token, { version, ...(artefactPath !== undefined && { artefactPath }) });
        } else {
          outcome = token.outcome;
        }
      } else {
        // The connection's own socket: `updates.apply` of this client's version, when idle.
        outcome = await registry.seams
          .request(environmentId, "updates.apply", { commandId: uuidv7(platform.clock.now()), version, when: "idle" })
          .then(answeredByMethod, (error: unknown) => failed("unreachable", error instanceof Error ? error.message : String(error)));
      }
      if (!isCurrent(environmentId, entry)) return outcome;
      if (outcome.ok && overRoute) {
        entry.runner.feed({ type: "update-taken" });
        entry.updateGeneration = (entry.updateGeneration ?? 0) + 1;
        entry.updatePoll?.cancel();
        await pollUpdate(environmentId, entry);
      }
      if (!outcome.ok && outcome.refused) {
        notices.raise(environmentId, {
          kind: "update-refused",
          message: `Could not update ${machine.name} to ${version} (${outcome.reason}): ${outcome.message}`,
          action: null,
        });
      }
      return outcome;
    },

    async updateEnvironmentNow(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      const service = platform.shell?.service;
      if (entry.saved.kind !== "local" || entry.runner.state.updateDeadline === null || !service?.pendingUpdate || !service.applyUpdateNow) {
        throw new Error("This client cannot advance that environment's update across the protocol gap.");
      }
      const pending = await service.pendingUpdate();
      if (!isCurrent(environmentId, entry) || entry.runner.state.updateDeadline === null || !idleHold(pending)) {
        throw new Error("The update is no longer waiting only on the idle window.");
      }
      await service.applyUpdateNow();
      if (!isCurrent(environmentId, entry) || entry.runner.state.updateDeadline === null) return;
      entry.updateGeneration = (entry.updateGeneration ?? 0) + 1;
      entry.updatePoll?.cancel();
      entry.updateRestarting = true;
      entry.updatePending = null;
      entry.updateError = null;
      publish();
      void pollUpdate(environmentId, entry);
    },

    close() {
      closed = true;
      for (const entry of entries.values()) entry.updatePoll?.cancel();
      stopNetwork?.();
      stopNetwork = undefined;
      for (const entry of entries.values()) entry.runner.stop();
      for (const id of [...syncing.keys()]) endSyncing(id);
    },
  };
  return registry;
};

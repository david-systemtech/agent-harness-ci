import { ClientSessionCredential, commandResponse, type DiscoveryDocument, type Frame, type ResponseFrame } from "@agent-harness/contracts";
import { exchangeGrant, readsGrant, type GrantExchange, type LocalStatus } from "../bootstrap.js";
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
import { SocketClosedError, authenticate, dial, type LiveSocket, type SocketClosed } from "./connection.js";
import {
  LOCAL_ENVIRONMENT_DOCUMENT,
  NO_PREFERENCES,
  PAIRED_CONNECTIONS_DOCUMENT,
  PREFERENCE_KEYS,
  emptyDescriptor,
  readPairedConnections,
  readPreferences,
  readRememberedLocal,
  writePairedConnections,
  type ClientPreferences,
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

export type { RemoveResult } from "./records.js";

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
}

export interface Registry extends Connections {
  readonly preferences: Observable<ClientPreferences>;
  readonly notices: Notices;
  readonly local: Observable<LocalStatus>;
  readonly seams: ConnectionSeams;
  /** One connection's record. */
  record(environmentId: string): ConnectionRecord | undefined;
  /** Reads the saved connections and preferences, exchanges the local grant, and starts every connection's machine; settles once each first attempt has. */
  start(): Promise<void>;
  close(): void;
}

/** How long a revoke waits for its answer before the connection is forgotten anyway. A chosen default. */
export const REVOKE_TIMEOUT_MS = 10_000;

interface Entry {
  saved: SavedConnection;
  /** The connection's state machine and the one owner of its socket, timers and retries. */
  readonly runner: Runner;
  /** A local connection's token, held in memory only: it lives as long as the record, which is never saved. */
  token: string | undefined;
}

const unknownEnvironment = (environmentId: string) => new Error(`There is no saved connection to environment ${environmentId}.`);

const fromDiscovery = (descriptor: EnvironmentDescriptor, document: DiscoveryDocument): EnvironmentDescriptor => ({
  ...descriptor,
  name: document.environmentName,
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

export const createRegistry = (platform: Platform, protocolVersion: number, notices: Notices): Registry => {
  const entries = new Map<string, Entry>();
  // A fault with no caller to take it: a renderer's listener that threw, a background write that failed.
  const report = (error: unknown): void => (platform.reportError ? platform.reportError(error) : void Promise.reject(error));
  const prefs = writable<ClientPreferences>(NO_PREFERENCES, report);
  const list = writable<readonly ConnectionRecord[]>([], report);
  const local = writable<LocalStatus>({ state: "none" }, report);
  const frameListeners = new Set<(environmentId: string, frame: Frame) => void>();
  const closeListeners = new Set<(environmentId: string, closed: SocketClosed) => void>();
  const forgetListeners = new Set<(environmentId: string) => void | Promise<void>>();
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
      phase: machine.phase,
      bye: machine.bye,
      retryAt: iso(machine.retryAt),
      unreachableSince: iso(machine.unreachableSince),
      refreshFailed: machine.refreshFailed,
      action: actionOf(machine),
    };
  };

  /** The known connections in the saved sequence; any the sequence does not name follow, in the order they became known. */
  const publish = () => {
    const sequence = prefs.read()["environments.sequence"];
    const rank = (id: string) => {
      const at = sequence.indexOf(id);
      return at === -1 ? sequence.length : at;
    };
    const ids = [...entries.keys()].sort((a, b) => rank(a) - rank(b));
    list.set(ids.map((id) => toRecord(id, entries.get(id) as Entry)));
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
    enqueue(() => platform.documents.set(LOCAL_ENVIRONMENT_DOCUMENT, { environmentId, address: saved.address, descriptor: saved.descriptor }));

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
    if (!exchange.ok) {
      local.set(exchange.status);
      const status = exchange.status;
      return status.state === "failed"
        ? { kind: "grant-failed", reason: status.reason, message: status.message }
        : { kind: "grant-failed", reason: "service-down", message: "This client reads no grant." };
    }
    // A grant that is now another environment's: discovery's check blocks it `different-environment`, and the next start takes that one as the local environment.
    if (exchange.discovery.environmentId !== environmentId) return { kind: "document", document: exchange.discovery };
    entry.token = exchange.credential.token;
    local.set({ state: "exchanged", environmentId });
    await updateSaved(environmentId, entry, {
      address: exchange.origin,
      clientSessionId: exchange.credential.clientSessionId,
      scopes: [...exchange.credential.scopes],
      ceiling: exchange.credential.ceiling,
      expiresAt: exchange.credential.expiresAt,
    });
    return { kind: "document", document: exchange.discovery };
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

  /** What the runner of `entry` needs of the registry. */
  const hostFor = (environmentId: string, entry: () => Entry): RunnerHost => ({
    clock: platform.clock,
    random: platform.random ?? Math.random,
    async discover() {
      const e = entry();
      if (e.saved.kind === "local" && e.token === undefined) return exchangeLocal(environmentId, e);
      const read = await readDiscovery(platform.fetch, e.saved.address);
      if (read.ok) return { kind: "document", document: read.document };
      // Something answered, but not with a discovery document: not the service being down, a fault the ladder retries.
      return read.kind === "unreachable" ? { kind: "unreachable", message: read.message } : { kind: "malformed", message: read.message };
    },
    token: async () => {
      const e = entry();
      return e.saved.kind === "local" ? e.token : platform.secrets.get(environmentId);
    },
    expiresAt: () => {
      const at = entry().saved.expiresAt;
      return at === null ? null : Date.parse(at);
    },
    dial: (token) => dial({ webSocket: platform.webSocket, origin: entry().saved.address, token, client: platform.client, protocolVersion }),
    async attach(socket, document) {
      const e = entry();
      const { hello } = socket;
      socket.onFrame((frame) => notifyAll(frameListeners, environmentId, frame));
      const descriptor = document ? fromDiscovery(e.saved.descriptor, document) : e.saved.descriptor;
      await updateSaved(environmentId, e, {
        clientSessionId: hello.clientSessionId,
        scopes: [...hello.scopes],
        ceiling: hello.ceiling,
        blocked: null,
        descriptor: {
          ...descriptor,
          name: hello.environmentName,
          protocolVersion: hello.protocolVersion,
          capabilities: [...hello.capabilities],
          lastSeen: platform.clock.now().toISOString(),
        },
      });
    },
    describe: (document) => updateSaved(environmentId, entry(), { descriptor: fromDiscovery(entry().saved.descriptor, document) }),
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
      if (!isCurrent(environmentId, e)) return;
      if (next.blocked !== previous.blocked) return updateSaved(environmentId, e, { blocked: next.blocked });
      publish();
    },
    lost: (how) => notifyAll(closeListeners, environmentId, how),
    report,
  });

  const newEntry = (environmentId: string, saved: SavedConnection, token?: string): Entry => {
    const machine = initialMachine({
      environmentId,
      protocolVersion,
      kind: saved.kind,
      name: saved.descriptor.name,
      blocked: saved.blocked,
      capabilities: saved.descriptor.capabilities,
    });
    const entry: Entry = { saved, token, runner: createRunner(hostFor(environmentId, () => entry), machine) };
    return entry;
  };

  /** Starts `entry`'s machine: an attempt if enabled and online. */
  const begin = (environmentId: string, entry: Entry) =>
    entry.runner.feed({
      type: "start",
      enabled: isEnabled(environmentId),
      network: platform.network.read(),
      // What #127 caches hangs off an environment reached before; until then, one with a `hello` on record.
      hasCache: entry.saved.descriptor.lastSeen !== null,
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
    const token = await platform.secrets.get(environmentId);
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

  /**
   * Takes the local connection from a grant exchange. A paired connection to
   * the same environment is replaced: its client session is revoked with the
   * new local one (which holds every scope), then its record and token are
   * forgotten.
   */
  const adoptLocal = async (exchange: Extract<GrantExchange, { ok: true }>) => {
    const id = exchange.discovery.environmentId;
    const previous = entries.get(id);
    previous?.runner.stop();
    if (previous?.saved.kind === "paired") {
      const token = await platform.secrets.get(id);
      if (previous.saved.clientSessionId !== null && token !== undefined) {
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
    entries.set(id, newEntry(id, saved, exchange.credential.token));
    if (previous?.saved.kind === "paired") await savePaired();
    await rememberLocal(id, saved);
    await enterSequence(id, "first");
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
        if (!socket) return Promise.reject(new Error(`Environment ${environmentId} is not connected.`));
        return socket.request(method, params);
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
      await Promise.all([...entries.values()].map((entry) => entry.runner.settled()));
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
      if (existing) {
        // The old socket is the registry's now: revoking over it (or the new one) closes it with a `bye: revoked` its machine must not hear.
        const held = existing.runner.detach();
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
      const entry = existing ?? newEntry(id, saved);
      if (existing) {
        await updateSaved(id, existing, saved);
      } else {
        entries.set(id, entry);
        await savePaired();
        await enterSequence(id, "last");
      }
      if (answer.ok && isEnabled(id)) {
        // The socket pairing tried is the connection's first one.
        entry.runner.adopt(answer.socket, document);
      } else {
        // Closed before `hello`, or disabled: the machine starts from where it is, as at a start.
        if (answer.ok) answer.socket.close();
        begin(id, entry);
      }
      await entry.runner.settled();
      return { status: "paired", environmentId: id, ...(replaced && { replaced }) };
    },

    async setAddress(environmentId, address) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      const origin = parseAddress(address);
      if (!origin) throw new RangeError(`"${address}" is not an address.`);
      await updateSaved(environmentId, entry, { address: origin });
      entry.runner.feed({ type: "retryNow" });
      await entry.runner.settled();
    },

    async setEnabled(environmentId, enabled) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      await setPreferences((p) => ({ ...p, "environments.enabled": { ...p["environments.enabled"], [environmentId]: enabled } }));
      if (!enabled) return entry.runner.feed({ type: "disable" });
      begin(environmentId, entry);
      await entry.runner.settled();
    },

    async setOrder(environmentIds) {
      if (!loaded) await ensureLoaded();
      const known = new Set(entries.keys());
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
      await setPreferences((p) => ({ ...p, "environments.lastUsed": environmentId }));
    },

    async remove(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      if (entry.saved.kind === "local") {
        throw new Error("The local environment's connection comes from its bootstrap grant on every start; disable it instead.");
      }
      const socket = entry.runner.detach();
      const result = await revokeHeld(environmentId, entry, socket);
      socket?.close();
      entry.runner.stop();
      entries.delete(environmentId);
      await platform.secrets.delete(environmentId);
      await savePaired();
      await setPreferences((p) => ({
        "environments.sequence": p["environments.sequence"].filter((id) => id !== environmentId),
        "environments.enabled": Object.fromEntries(Object.entries(p["environments.enabled"]).filter(([id]) => id !== environmentId)),
        "environments.lastUsed": p["environments.lastUsed"] === environmentId ? null : p["environments.lastUsed"],
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

    async retryNow(environmentId) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      entry.runner.feed({ type: "retryNow" });
      await entry.runner.settled();
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
      await entry.runner.settled();
    },

    close() {
      closed = true;
      stopNetwork?.();
      stopNetwork = undefined;
      for (const entry of entries.values()) entry.runner.stop();
    },
  };
  return registry;
};

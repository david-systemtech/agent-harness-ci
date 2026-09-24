import type { ClientSessionCredential, DiscoveryDocument, Frame, ResponseFrame } from "@agent-harness/contracts";
import { compareProtocol, readDiscovery } from "../discovery.js";
import { uuidv7 } from "../ids.js";
import { writable, type Observable } from "../observable.js";
import { exchangeCode, failed, parsePairingInput, type PairingInput, type PairingOptions, type PairingOutcome } from "../pairing.js";
import type { Platform, Timer } from "../platform.js";
import { parseAddress } from "./address.js";
import { authenticate, type LiveSocket, type SocketClosed } from "./connection.js";
import {
  NO_PREFERENCES,
  PAIRED_CONNECTIONS_DOCUMENT,
  PREFERENCE_KEYS,
  emptyDescriptor,
  readPairedConnections,
  readPreferences,
  writePairedConnections,
  type BlockedReason,
  type ClientPreferences,
  type ConnectionPhase,
  type ConnectionRecord,
  type EnvironmentDescriptor,
  type SavedConnection,
} from "./records.js";

/**
 * The connection registry (docs/specs/client-runtime.md, "The connection
 * registry"): every connection by environment id, the client-local
 * preferences, and the in-process `connections.*` API. Each connection
 * makes one attempt when asked (start, add, an address edit, enable,
 * `retryNow`); the reconnect machine (#126) will own retries.
 */

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
  /** Revokes the client session when reachable, then forgets the token, the record and what hangs off it. */
  remove(environmentId: string): Promise<void>;
  /** Makes the connection's attempt again now: discovery, `auth`, `hello`. */
  retryNow(environmentId: string): Promise<void>;
}

/** Where the rest of the runtime attaches to connections: #126's machine, #127's subscriptions, #128's outbox. */
export interface ConnectionSeams {
  /** Every frame after `hello` on any connection, with its environment. */
  onFrame(listener: (environmentId: string, frame: Frame) => void): () => void;
  /** A ready socket closed without this runtime closing it. */
  onClose(listener: (environmentId: string, closed: SocketClosed) => void): () => void;
  /** An environment was removed: drop its caches, cursors and outbox. Awaited before `remove` settles. */
  onForget(listener: (environmentId: string) => void | Promise<void>): () => void;
  /** A request on the environment's ready socket; rejects when there is none. */
  request(environmentId: string, method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
}

export interface Registry extends Connections {
  readonly preferences: Observable<ClientPreferences>;
  readonly seams: ConnectionSeams;
  /** One connection's record. */
  record(environmentId: string): ConnectionRecord | undefined;
  /** Reads the saved connections and preferences. */
  load(): Promise<void>;
  /** Takes the local connection from a grant exchange: kept in memory only, put first when it is new to the sequence. */
  adoptLocal(origin: string, discovery: DiscoveryDocument, credential: ClientSessionCredential): Promise<void>;
  /** Makes one attempt on every enabled connection. */
  connectAll(): Promise<void>;
  close(): void;
}

/** How long removal waits for the revoke's answer before forgetting anyway. A chosen default. */
export const REVOKE_TIMEOUT_MS = 10_000;

interface Entry {
  saved: SavedConnection;
  phase: ConnectionPhase;
  bye: ConnectionRecord["bye"];
  socket: LiveSocket | undefined;
  /** Bumped by every attempt and every close this runtime makes, so a stale attempt's outcome is dropped. */
  attempt: number;
}

const unknownEnvironment = (environmentId: string) => new Error(`There is no saved connection to environment ${environmentId}.`);

const fromDiscovery = (descriptor: EnvironmentDescriptor, document: DiscoveryDocument): EnvironmentDescriptor => ({
  ...descriptor,
  name: document.environmentName,
  harnessVersion: document.harnessVersion,
  protocolVersion: document.protocolVersion,
  capabilities: [...document.capabilities],
});

export const createRegistry = (platform: Platform, protocolVersion: number): Registry => {
  const entries = new Map<string, Entry>();
  const prefs = writable<ClientPreferences>(NO_PREFERENCES);
  const list = writable<readonly ConnectionRecord[]>([]);
  const frameListeners = new Set<(environmentId: string, frame: Frame) => void>();
  const closeListeners = new Set<(environmentId: string, closed: SocketClosed) => void>();
  const forgetListeners = new Set<(environmentId: string) => void | Promise<void>>();
  let closed = false;
  // Writes go one after another, so an older write never lands over a newer one.
  let writes: Promise<void> = Promise.resolve();

  const isEnabled = (environmentId: string) => prefs.read()["environments.enabled"][environmentId] !== false;

  const toRecord = (environmentId: string, entry: Entry): ConnectionRecord => ({
    environmentId,
    ...entry.saved,
    enabled: isEnabled(environmentId),
    phase: entry.phase,
    bye: entry.bye,
  });

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

  const savePaired = () => enqueue(() => platform.documents.set(PAIRED_CONNECTIONS_DOCUMENT, writePairedConnections([...entries].map(([id, entry]) => [id, entry.saved]))));

  const setPreferences = (change: (current: ClientPreferences) => ClientPreferences) => {
    prefs.update(change);
    publish();
    const now = prefs.read();
    return enqueue(async () => {
      for (const key of PREFERENCE_KEYS) await platform.documents.set(key, now[key]);
    });
  };

  const update = (environmentId: string, entry: Entry, change: Partial<Entry>) => {
    Object.assign(entry, change);
    if (entries.get(environmentId) === entry) publish();
  };

  const updateSaved = async (environmentId: string, entry: Entry, change: Partial<SavedConnection>, phase?: ConnectionPhase) => {
    update(environmentId, entry, { saved: { ...entry.saved, ...change }, ...(phase !== undefined && { phase }) });
    if (entry.saved.kind === "paired" && entries.get(environmentId) === entry) await savePaired();
  };

  /** Closes the socket this runtime holds, as this runtime's own close: no `onClose` is heard for it. */
  const drop = (entry: Entry) => {
    entry.attempt++;
    const socket = entry.socket;
    entry.socket = undefined;
    socket?.close();
  };

  const block = (environmentId: string, entry: Entry, reason: BlockedReason) =>
    updateSaved(environmentId, entry, { blocked: reason }, "blocked");

  /**
   * One attempt: discovery at the record's address, checked for the
   * environment's id, protocol version and readiness; then `auth` with the
   * token; then `hello`, checked for the id again, which fills the record. A
   * discovery naming another environment blocks before any token is sent.
   */
  const connect = async (environmentId: string): Promise<void> => {
    const entry = entryOf(environmentId);
    drop(entry);
    if (closed) return;
    if (!isEnabled(environmentId)) return update(environmentId, entry, { phase: "disabled" });
    const attempt = entry.attempt;
    const current = () => entry.attempt === attempt && entries.get(environmentId) === entry && !closed;
    update(environmentId, entry, { phase: "connecting" });

    const discovery = await readDiscovery(platform.fetch, entry.saved.address);
    if (!current()) return;
    if (!discovery.ok) return update(environmentId, entry, { phase: "unreachable" });
    const document = discovery.document;
    if (document.environmentId !== environmentId) return block(environmentId, entry, "different-environment");
    const mismatch = compareProtocol(document.protocolVersion, protocolVersion);
    if (mismatch) return block(environmentId, entry, mismatch.reason);
    if (document.readiness !== "ready") {
      return updateSaved(environmentId, entry, { blocked: null, descriptor: fromDiscovery(entry.saved.descriptor, document) }, "not-ready");
    }
    const token = await platform.secrets.get(environmentId);
    if (!current()) return;
    // A record with no token has no client session to use: it is paired again, as a revoked one is.
    if (token === undefined) return block(environmentId, entry, "revoked");

    const answer = await authenticate({
      webSocket: platform.webSocket,
      origin: entry.saved.address,
      token,
      environmentId,
      client: platform.client,
      protocolVersion,
    });
    if (!current()) {
      if (answer.ok) answer.socket.close();
      return;
    }
    if (!answer.ok) {
      if (answer.failure === "different-environment") return block(environmentId, entry, "different-environment");
      return update(environmentId, entry, { phase: "disconnected", bye: answer.closed.bye?.reason ?? null });
    }
    const { socket } = answer;
    const { hello } = socket;
    entry.socket = socket;
    socket.onFrame((frame) => {
      for (const listener of [...frameListeners]) listener(environmentId, frame);
    });
    void socket.closed.then((how) => {
      if (entry.socket !== socket) return;
      entry.socket = undefined;
      update(environmentId, entry, { phase: "disconnected", bye: how.bye?.reason ?? null });
      for (const listener of [...closeListeners]) listener(environmentId, how);
    });
    entry.bye = null;
    await updateSaved(
      environmentId,
      entry,
      {
        clientSessionId: hello.clientSessionId,
        scopes: [...hello.scopes],
        ceiling: hello.ceiling,
        blocked: null,
        descriptor: {
          ...fromDiscovery(entry.saved.descriptor, document),
          name: hello.environmentName,
          protocolVersion: hello.protocolVersion,
          capabilities: [...hello.capabilities],
          lastSeen: platform.clock.now().toISOString(),
        },
      },
      "ready",
    );
  };

  const newEntry = (saved: SavedConnection): Entry => ({ saved, phase: "disabled", bye: null, socket: undefined, attempt: 0 });

  /** Revokes the connection's client session over its socket, best effort: an answer, a close or the timeout ends the wait. */
  const revoke = async (entry: Entry): Promise<void> => {
    const socket = entry.socket;
    if (entry.phase !== "ready" || !socket || entry.saved.clientSessionId === null) return;
    let timer: Timer | undefined;
    const timeout = new Promise<void>((resolve) => (timer = platform.clock.setTimeout(resolve, REVOKE_TIMEOUT_MS)));
    const answered = socket
      .request("access.sessions.revoke", { commandId: uuidv7(platform.clock.now()), clientSessionId: entry.saved.clientSessionId })
      .then(
        () => undefined,
        () => undefined,
      );
    await Promise.race([answered, timeout]);
    timer?.cancel();
  };

  const registry: Registry = {
    list,
    preferences: prefs,
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
        const socket = entries.get(environmentId)?.socket;
        if (!socket) return Promise.reject(new Error(`Environment ${environmentId} is not connected.`));
        return socket.request(method, params);
      },
    },

    record(environmentId) {
      const entry = entries.get(environmentId);
      return entry && toRecord(environmentId, entry);
    },

    async load() {
      const [paired, ...stored] = await Promise.all([
        platform.documents.get(PAIRED_CONNECTIONS_DOCUMENT),
        ...PREFERENCE_KEYS.map((key) => platform.documents.get(key)),
      ]);
      const [sequence, enabled, lastUsed] = stored;
      prefs.set(
        readPreferences({ "environments.sequence": sequence, "environments.enabled": enabled, "environments.lastUsed": lastUsed }),
      );
      for (const [id, saved] of readPairedConnections(paired)) entries.set(id, newEntry(saved));
      publish();
    },

    async adoptLocal(origin, discovery, credential) {
      const id = discovery.environmentId;
      const previous = entries.get(id);
      if (previous) drop(previous);
      await platform.secrets.set(id, credential.token);
      // The local connection replaces a paired one to the same environment: it is the better credential on this machine.
      entries.set(
        id,
        newEntry({
          address: origin,
          kind: "local",
          clientSessionId: credential.clientSessionId,
          scopes: [...credential.scopes],
          ceiling: credential.ceiling,
          descriptor: fromDiscovery(previous?.saved.descriptor ?? emptyDescriptor(discovery.environmentName), discovery),
          blocked: null,
        }),
      );
      if (previous?.saved.kind === "paired") await savePaired();
      const sequence = prefs.read()["environments.sequence"];
      if (sequence.includes(id)) publish();
      else await setPreferences((p) => ({ ...p, "environments.sequence": [id, ...sequence] }));
    },

    async connectAll() {
      await Promise.all([...entries.keys()].map((id) => connect(id)));
    },

    async add(input, options = {}) {
      const parsed = parsePairingInput(input);
      if (!parsed.ok) return { status: "failed", failure: parsed.failure };
      const { origin, code } = parsed;
      if (options.rePair !== undefined) entryOf(options.rePair);

      const discovery = await readDiscovery(platform.fetch, origin);
      if (!discovery.ok) return failed("unreachable", discovery.message);
      const document = discovery.document;
      if (document.readiness !== "ready") return failed("not-ready", `${document.environmentName} is ${document.readiness}; try again once it is ready.`);
      const mismatch = compareProtocol(document.protocolVersion, protocolVersion);
      if (mismatch) return failed("protocol-mismatch", mismatch.message);
      const id = document.environmentId;
      if (options.rePair !== undefined && options.rePair !== id) {
        const saved = entries.get(options.rePair)?.saved.descriptor.name ?? options.rePair;
        return failed("different-environment", `That code is for ${document.environmentName}, not ${saved}.`);
      }
      const existing = entries.get(id);
      if (existing && options.rePair === undefined) {
        return { status: "re-pair-offered", environmentId: id, name: existing.saved.descriptor.name };
      }

      const exchanged = await exchangeCode(platform.fetch, origin, code, platform.client, protocolVersion);
      if (!exchanged.ok) return { status: "failed", failure: exchanged.failure };
      const { credential } = exchanged;
      await platform.secrets.set(id, credential.token);
      const saved: SavedConnection = {
        address: origin,
        kind: existing?.saved.kind ?? "paired",
        clientSessionId: credential.clientSessionId,
        scopes: [...credential.scopes],
        ceiling: credential.ceiling,
        descriptor: fromDiscovery(existing?.saved.descriptor ?? emptyDescriptor(document.environmentName), document),
        blocked: null,
      };
      if (existing) {
        drop(existing);
        await updateSaved(id, existing, saved);
      } else {
        entries.set(id, newEntry(saved));
        await savePaired();
        const sequence = prefs.read()["environments.sequence"];
        await setPreferences((p) => ({ ...p, "environments.sequence": [...sequence.filter((known) => known !== id), id] }));
      }
      await connect(id);
      const after = entries.get(id);
      if (after?.saved.blocked === "different-environment") {
        return failed("different-environment", `The environment at ${origin} is not the one its discovery document named.`);
      }
      return { status: "paired", environmentId: id };
    },

    async setAddress(environmentId, address) {
      const entry = entryOf(environmentId);
      const origin = parseAddress(address);
      if (!origin) throw new RangeError(`"${address}" is not an address.`);
      drop(entry);
      await updateSaved(environmentId, entry, { address: origin });
      await connect(environmentId);
    },

    async setEnabled(environmentId, enabled) {
      const entry = entryOf(environmentId);
      await setPreferences((p) => ({ ...p, "environments.enabled": { ...p["environments.enabled"], [environmentId]: enabled } }));
      if (enabled) return connect(environmentId);
      drop(entry);
      update(environmentId, entry, { phase: "disabled" });
    },

    async setOrder(environmentIds) {
      const known = new Set(entries.keys());
      const given = new Set(environmentIds);
      if (given.size !== environmentIds.length || given.size !== known.size || [...given].some((id) => !known.has(id))) {
        throw new RangeError("The sequence must name every saved environment exactly once.");
      }
      // Environments not known this start (a local one whose service is down) keep their place after the known ones.
      await setPreferences((p) => ({
        ...p,
        "environments.sequence": [...environmentIds, ...p["environments.sequence"].filter((id) => !given.has(id))],
      }));
    },

    async setLastUsed(environmentId) {
      entryOf(environmentId);
      await setPreferences((p) => ({ ...p, "environments.lastUsed": environmentId }));
    },

    async remove(environmentId) {
      const entry = entryOf(environmentId);
      if (entry.saved.kind === "local") {
        throw new Error("The local environment's connection comes from its bootstrap grant on every start; disable it instead.");
      }
      await revoke(entry);
      drop(entry);
      entries.delete(environmentId);
      await platform.secrets.delete(environmentId);
      await savePaired();
      await setPreferences((p) => ({
        "environments.sequence": p["environments.sequence"].filter((id) => id !== environmentId),
        "environments.enabled": Object.fromEntries(Object.entries(p["environments.enabled"]).filter(([id]) => id !== environmentId)),
        "environments.lastUsed": p["environments.lastUsed"] === environmentId ? null : p["environments.lastUsed"],
      }));
      for (const listener of [...forgetListeners]) await listener(environmentId);
    },

    async retryNow(environmentId) {
      entryOf(environmentId);
      await connect(environmentId);
    },

    close() {
      closed = true;
      for (const entry of entries.values()) drop(entry);
    },
  };
  return registry;
};

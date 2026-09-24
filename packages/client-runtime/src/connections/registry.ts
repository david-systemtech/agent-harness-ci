import type { DiscoveryDocument, Frame, HelloFrame, ResponseFrame } from "@agent-harness/contracts";
import { exchangeGrant, readsGrant, type GrantExchange, type LocalFailureReason, type LocalStatus } from "../bootstrap.js";
import { checkDiscovery, compareProtocol, readDiscovery, type ProtocolRefusal } from "../discovery.js";
import { uuidv7 } from "../ids.js";
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
import { SocketClosedError, authenticate, type LiveSocket, type SocketClosed } from "./connection.js";
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
  type BlockedReason,
  type ClientPreferences,
  type ConnectionPhase,
  type ConnectionRecord,
  type EnvironmentDescriptor,
  type RemoveResult,
  type SavedConnection,
} from "./records.js";

/**
 * The connection registry (docs/specs/client-runtime.md, "The connection
 * registry"): every connection by environment id, the client-local
 * preferences, and the in-process `connections.*` API. Each connection
 * makes one attempt when asked (start, add, an address edit, enable,
 * `retryNow`); the reconnect machine (#126) will own retries.
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
  /** Makes the connection's attempt again now: the local grant exchange if it is due, discovery, `auth`, `hello`. */
  retryNow(environmentId: string): Promise<void>;
}

/** Where the rest of the runtime attaches to connections: #126's machine, #127's subscriptions, #128's outbox. Internal: never on `Runtime`. */
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
  readonly local: Observable<LocalStatus>;
  readonly seams: ConnectionSeams;
  /** One connection's record. */
  record(environmentId: string): ConnectionRecord | undefined;
  /** Reads the saved connections and preferences, exchanges the local grant, and makes one attempt on every enabled connection. */
  start(): Promise<void>;
  close(): void;
}

/** How long a revoke waits for its answer before the connection is forgotten anyway. A chosen default. */
export const REVOKE_TIMEOUT_MS = 10_000;

interface Entry {
  saved: SavedConnection;
  phase: ConnectionPhase;
  bye: ConnectionRecord["bye"];
  socket: LiveSocket | undefined;
  /** Bumped by every attempt and every close this runtime makes, so a stale attempt's outcome is dropped. */
  attempt: number;
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

/** Whether a `hello` may be used for `environmentId`: it names that environment, and speaks the client's protocol. */
const admitHello = (
  hello: HelloFrame,
  environmentId: string,
  protocolVersion: number,
): { readonly reason: "different-environment" | ProtocolRefusal; readonly message: string } | undefined => {
  if (hello.environmentId !== environmentId) {
    return { reason: "different-environment", message: `The environment that answered is ${hello.environmentName}, not the one its address named.` };
  }
  return compareProtocol(hello.protocolVersion, protocolVersion);
};

/** Where a close leaves a connection, by the `bye` before it (the spec's "`bye` reasons"); clearing the token and the notice are #126's. */
const afterClose = (closed: SocketClosed, protocolVersion: number): { phase: ConnectionPhase; blocked?: BlockedReason } => {
  switch (closed.bye?.reason) {
    case "revoked":
    case "unauthorized":
      return { phase: "blocked", blocked: "revoked" };
    case "expired":
      return { phase: "blocked", blocked: "expired" };
    case "protocol": {
      const theirs = closed.bye.protocolVersion;
      return { phase: "blocked", blocked: (theirs === undefined ? undefined : compareProtocol(theirs, protocolVersion)?.reason) ?? "protocol-mismatch" };
    }
    case "draining":
      return { phase: "draining" };
    case "updating":
      return { phase: "updating" };
    case undefined:
      return { phase: "backoff" };
  }
};

/** Where a failed local grant exchange leaves the local connection. */
const afterLocalFailure = (reason: LocalFailureReason): { phase: ConnectionPhase; blocked?: BlockedReason } => {
  switch (reason) {
    case "service-down":
    case "starting":
    case "draining":
      return { phase: reason };
    case "unsupported-client":
    case "protocol-mismatch":
      return { phase: "blocked", blocked: reason };
    case "refused":
      return { phase: "backoff" };
  }
};

/** Whether a revoke's response says the client session is revoked: accepted, or rejected as unknown. */
const revokedBy = (response: ResponseFrame): boolean => {
  const receipt = (response.result as { receipt?: { status?: unknown; reason?: unknown } } | undefined)?.receipt;
  return receipt?.status === "accepted" || (receipt?.status === "rejected" && receipt.reason === "not_found");
};

export const createRegistry = (platform: Platform, protocolVersion: number): Registry => {
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

  /** Every phase change goes through here; leaving `blocked` clears the saved reason, so a record never shows one beside another phase. */
  const update = (environmentId: string, entry: Entry, change: Partial<Entry>) => {
    Object.assign(entry, change);
    const unblocked = change.phase !== undefined && change.phase !== "blocked" && entry.saved.blocked !== null;
    if (unblocked) entry.saved = { ...entry.saved, blocked: null };
    if (entries.get(environmentId) !== entry) return;
    publish();
    if (unblocked && entry.saved.kind === "paired") savePaired().catch(report);
  };

  const updateSaved = async (environmentId: string, entry: Entry, change: Partial<SavedConnection>, phase?: ConnectionPhase) => {
    update(environmentId, entry, { saved: { ...entry.saved, ...change }, ...(phase !== undefined && { phase }) });
    if (entries.get(environmentId) !== entry) return;
    await (entry.saved.kind === "paired" ? savePaired() : rememberLocal(environmentId, entry.saved));
  };

  /** Closes the socket this runtime holds, as this runtime's own close: no `onClose` is heard for it. */
  const drop = (entry: Entry) => {
    entry.attempt++;
    const socket = entry.socket;
    entry.socket = undefined;
    socket?.close();
  };

  const settle = (environmentId: string, entry: Entry, outcome: { phase: ConnectionPhase; blocked?: BlockedReason }) => {
    // A local connection's client session revoked or expired is dead: its token is dropped, so the next attempt exchanges the grant again.
    if (entry.saved.kind === "local" && (outcome.blocked === "revoked" || outcome.blocked === "expired")) entry.token = undefined;
    return outcome.blocked === undefined
      ? update(environmentId, entry, { phase: outcome.phase })
      : updateSaved(environmentId, entry, { blocked: outcome.blocked }, "blocked");
  };

  const tokenOf = async (environmentId: string, entry: Entry) =>
    entry.saved.kind === "local" ? entry.token : platform.secrets.get(environmentId);

  /** Takes a socket `hello` was said and admitted on: the record is filled from it and the seams hear it. */
  const attach = async (environmentId: string, entry: Entry, socket: LiveSocket, document: DiscoveryDocument) => {
    const { hello } = socket;
    entry.socket = socket;
    socket.onFrame((frame) => notifyAll(frameListeners, environmentId, frame));
    void socket.closed.then((how) => {
      if (entry.socket !== socket) return;
      entry.socket = undefined;
      entry.bye = how.bye?.reason ?? null;
      Promise.resolve(settle(environmentId, entry, afterClose(how, protocolVersion))).catch(report);
      notifyAll(closeListeners, environmentId, how);
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

  /** Exchanges the local grant for this entry: its token and client session, or where the failure leaves it. */
  const exchangeLocal = async (environmentId: string, entry: Entry, current: () => boolean): Promise<boolean> => {
    const exchange = await exchangeGrant({ fetch: platform.fetch, grant: platform.grant, client: platform.client, protocolVersion });
    if (!current()) return false;
    if (!exchange.ok) {
      local.set(exchange.status);
      if (exchange.status.state === "failed") await settle(environmentId, entry, afterLocalFailure(exchange.status.reason));
      return false;
    }
    if (exchange.discovery.environmentId !== environmentId) {
      // The grant is now another environment's: the next start takes that one as the local environment.
      await settle(environmentId, entry, { phase: "blocked", blocked: "different-environment" });
      return false;
    }
    entry.token = exchange.credential.token;
    local.set({ state: "exchanged", environmentId });
    await updateSaved(environmentId, entry, {
      address: exchange.origin,
      clientSessionId: exchange.credential.clientSessionId,
      scopes: [...exchange.credential.scopes],
      ceiling: exchange.credential.ceiling,
    });
    return true;
  };

  /**
   * One attempt: for a local connection without a token, the grant exchange
   * first; then discovery at the record's address, checked for readiness,
   * protocol and the environment's id before any token is sent; then `auth`;
   * then `hello`, checked for the id and protocol again, which fills the record.
   */
  const connect = async (environmentId: string): Promise<void> => {
    const entry = entryOf(environmentId);
    drop(entry);
    if (closed) return;
    if (!isEnabled(environmentId)) return update(environmentId, entry, { phase: "disabled" });
    const attempt = entry.attempt;
    const current = () => entry.attempt === attempt && entries.get(environmentId) === entry && !closed;
    update(environmentId, entry, { phase: "connecting" });

    if (entry.saved.kind === "local" && entry.token === undefined && !(await exchangeLocal(environmentId, entry, current))) return;
    if (!current()) return;
    const discovery = await readDiscovery(platform.fetch, entry.saved.address);
    if (!current()) return;
    // Nothing answering the local environment's address is its service being down; anything else waits for a retry.
    if (!discovery.ok) {
      return update(environmentId, entry, { phase: entry.saved.kind === "local" && discovery.kind === "unreachable" ? "service-down" : "backoff" });
    }
    const document = discovery.document;
    const check = checkDiscovery(document, { protocolVersion, environmentId });
    if (!check.ok) {
      if (check.reason === "starting" || check.reason === "draining") {
        return updateSaved(environmentId, entry, { blocked: null, descriptor: fromDiscovery(entry.saved.descriptor, document) }, check.reason);
      }
      return settle(environmentId, entry, { phase: "blocked", blocked: check.reason });
    }
    const token = await tokenOf(environmentId, entry);
    if (!current()) return;
    // A connection with no token has no client session to use: it is paired again, as a revoked one is.
    if (token === undefined) return settle(environmentId, entry, { phase: "blocked", blocked: "revoked" });

    const answer = await authenticate({ webSocket: platform.webSocket, origin: entry.saved.address, token, client: platform.client, protocolVersion });
    if (!current()) {
      if (answer.ok) answer.socket.close();
      return;
    }
    if (!answer.ok) {
      entry.bye = answer.closed.bye?.reason ?? null;
      return settle(environmentId, entry, afterClose(answer.closed, protocolVersion));
    }
    const refusal = admitHello(answer.socket.hello, environmentId, protocolVersion);
    if (refusal) {
      answer.socket.close();
      return settle(environmentId, entry, { phase: "blocked", blocked: refusal.reason });
    }
    await attach(environmentId, entry, answer.socket, document);
  };

  const newEntry = (saved: SavedConnection, token?: string): Entry => ({
    saved,
    phase: "disabled",
    bye: null,
    socket: undefined,
    attempt: 0,
    token,
  });

  /**
   * Revokes the client session `entry` holds with its own token, over its
   * socket when it is ready, else over a one-off connection to `origin`:
   * what `remove` and a re-pair in place say about the session they give up.
   */
  const revokeHeld = async (environmentId: string, entry: Entry, origin: string = entry.saved.address): Promise<RemoveResult> => {
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
    const socket = entry.phase === "ready" ? entry.socket : undefined;
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
    if (previous) drop(previous);
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
    };
    entries.set(id, newEntry(saved, exchange.credential.token));
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
      for (const [id, saved] of readPairedConnections(paired)) if (!entries.has(id)) entries.set(id, newEntry(saved));
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

    async start() {
      const { remembered } = await ensureLoaded();

      if (readsGrant(platform.grant, platform.client)) {
        const exchange = await exchangeGrant({ fetch: platform.fetch, grant: platform.grant, client: platform.client, protocolVersion });
        if (exchange.ok) {
          await adoptLocal(exchange);
          local.set({ state: "exchanged", environmentId: exchange.discovery.environmentId });
        } else {
          local.set(exchange.status);
          // The local environment stays listed from what was remembered of it, with where the failure leaves it.
          const known = readRememberedLocal(remembered);
          if (known && !entries.has(known.environmentId) && exchange.status.state === "failed") {
            const entry = newEntry({ address: known.address, kind: "local", clientSessionId: null, scopes: [], ceiling: null, descriptor: known.descriptor, blocked: null });
            entries.set(known.environmentId, entry);
            await enterSequence(known.environmentId, "first");
            if (isEnabled(known.environmentId)) await settle(known.environmentId, entry, afterLocalFailure(exchange.status.reason));
          }
        }
      }
      // A local connection whose exchange failed at start waits for `retryNow`.
      await Promise.all(
        [...entries]
          .filter(([, entry]) => !(entry.saved.kind === "local" && entry.token === undefined))
          .map(([id]) => connect(id)),
      );
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
        drop(existing);
        const previous = existing.saved.clientSessionId;
        if (previous !== null) {
          const viaNew =
            answer.ok &&
            answer.socket.hello.scopes.includes("admin") &&
            (await revokeClientSession({ environmentId: id, origin, token: credential.token, clientSessionId: previous, socket: answer.socket }));
          replaced = viaNew ? { revoked: true } : await revokeHeld(id, existing, origin);
        }
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
      };
      const entry = existing ?? newEntry(saved);
      if (existing) {
        await updateSaved(id, existing, saved);
      } else {
        entries.set(id, entry);
        await savePaired();
        await enterSequence(id, "last");
      }
      if (!answer.ok) {
        entry.bye = answer.closed.bye?.reason ?? null;
        await settle(id, entry, afterClose(answer.closed, protocolVersion));
      } else if (isEnabled(id)) {
        await attach(id, entry, answer.socket, document);
      } else {
        answer.socket.close();
        update(id, entry, { phase: "disabled" });
      }
      return { status: "paired", environmentId: id, ...(replaced && { replaced }) };
    },

    async setAddress(environmentId, address) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      const origin = parseAddress(address);
      if (!origin) throw new RangeError(`"${address}" is not an address.`);
      drop(entry);
      await updateSaved(environmentId, entry, { address: origin });
      await connect(environmentId);
    },

    async setEnabled(environmentId, enabled) {
      if (!loaded) await ensureLoaded();
      const entry = entryOf(environmentId);
      await setPreferences((p) => ({ ...p, "environments.enabled": { ...p["environments.enabled"], [environmentId]: enabled } }));
      if (enabled) return connect(environmentId);
      drop(entry);
      update(environmentId, entry, { phase: "disabled" });
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
      const result = await revokeHeld(environmentId, entry);
      drop(entry);
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

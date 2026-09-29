import { X509Certificate, randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  KeyManagerCredential,
  httpOriginOf,
  invalidParams,
  type ErrorOf,
  type KeyManagerAuthMethod,
  type KeyManagerConnectionAddedPayload,
  type KeyManagerConnectionRecord,
  type KeyManagerConnectionSignedInPayload,
  type KeyManagerConnectionUpdatedPayload,
  type KeyManagerProvider,
  type KeyManagerStatus,
  type KeyManagerTokenInformation,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PrepareContext, PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { basePathProblem } from "./base-path.js";
import { addressHolder, connectionEver, importedHolder, injecting, listConnections, liveConnection, type StoredConnection } from "./connection-store.js";
import { openBaoProvider } from "./openbao.js";
import type { ConnectionProvider, ProviderFailure, SignInTarget } from "./provider.js";

/**
 * The key-manager connections (key-managers spec, "The connection record",
 * "Wire methods" and "Starting up"; ADR 0011, ADR 0028): the rules over the
 * store's read model, the credentials they keep in the vault and the logins
 * they hold in memory.
 *
 * - **A credential crosses the wire once.** Its secrets (a role id and a
 *   secret id, a password, a token) are registered with the scrub registry
 *   as they arrive, so no event, receipt, log line or answer can carry them;
 *   it is written to the vault before the command's transaction, one entry
 *   per credential given, and the entry is deleted again, and the
 *   registration let go, when the command is not accepted. A credential held
 *   stays registered while the vault holds it, from start.
 * - **The key manager is heard first.** Add, signIn and update (for a new
 *   address or CA) are prepared commands: their prepare signs in outside the
 *   transaction. A credential refused, or a root login, stores nothing
 *   (`verification_failed`); an add whose key manager does not answer, is
 *   sealed or rejects its certificate keeps the connection with that status
 *   and the credential; a signIn or an update refuses instead, keeping what
 *   it held.
 * - **The login's token is held in memory only**, registered for scrubbing
 *   while held. After the startup gate every connection with a credential
 *   signs in at once from it, `signing-in` until its outcome is recorded, so
 *   a restart logs in again.
 * - **A login the environment made is revoked** when it is replaced, signed
 *   out or removed, and when the command that made it is not accepted; a
 *   token a person gave is their own, never revoked, only let go.
 * - **A replaced or removed credential's entry** is deleted once its command
 *   has committed; a start deletes every key-manager entry no connection
 *   holds, whatever an interrupted deletion left.
 * - **One connection per provider and address**, and the first of a
 *   provider signed in injects (`injects`); the ticks are preset to every
 *   policy of the login at its first sign-in.
 */

/** The environment's own sign-ins' actor. */
export const KEY_MANAGER_ACTOR = formatActor({ kind: "system", id: "key-manager" });

/** What every vault entry holding a key-manager credential is named with. */
const VAULT_PREFIX = "key-manager:";

/** A new vault entry for a credential given to `connectionId`: one per credential, so a replacement never overwrites the one it replaces. */
const newEntry = (connectionId: string): string => `${VAULT_PREFIX}${connectionId}:${randomUUID()}`;

/** The providers this environment signs in to; the rest arrive with their tickets (#377 to #379). */
const PROVIDERS: Partial<Record<KeyManagerProvider, ConnectionProvider>> = { openbao: openBaoProvider };

/** How a provider is named to people. */
const PROVIDER_NAMES: Record<KeyManagerProvider, string> = { openbao: "OpenBao", doppler: "Doppler", onepassword: "1Password", bitwarden: "Bitwarden Secrets Manager" };

/** The secrets of a credential, each registered for scrubbing: a role id and a secret id, a password, or a token. */
const secretsOf = (credential: KeyManagerCredential): string[] => {
  switch (credential.method) {
    case "approle":
      return [credential.roleId, credential.secretId];
    case "userpass":
      return [credential.password];
    case "token":
      return [credential.token];
  }
};

/** Answers `invalid_params` for the param at `path`. */
const invalid = (path: readonly (string | number)[], message: string): never => {
  throw new ContractError(invalidParams([{ code: "custom", path: [...path], message }], message));
};

export interface KeyManagerConnectionsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's id: the id of its stream, where the connections' events go. */
  readonly environmentId: string;
  /** The vault as the environment holds it: every entry registered with the scrub registry while it is held. */
  readonly vault: Vault;
  readonly scrub: ScrubRegistry;
}

export interface KeyManagerConnections {
  /** Registers every credential the vault holds, and deletes the key-manager entries no connection holds; startup runs it once, before the wire opens. */
  start(): Promise<void>;
  /** After startup's gate: every connection with a credential signs in from it at once. */
  startSigningIn(): void;
  /** The connections, in the order they were added, each as it stands now. */
  list(): KeyManagerConnectionRecord[];
  /**
   * `keyManagers.connections.add`, prepared: the wire's, and the state
   * import's and the bulk copy's in process, which apply the handler its
   * prepare answers inside a command of their own.
   */
  readonly add: PreparedCommand<"keyManagers.connections.add">;
  readonly signIn: PreparedCommand<"keyManagers.connections.signIn">;
  readonly update: PreparedCommand<"keyManagers.connections.update">;
  readonly signOut: MethodHandler<"keyManagers.connections.signOut">;
  readonly remove: MethodHandler<"keyManagers.connections.remove">;
  /** Stops the sign-ins under way from recording anything, and lets go of every login and credential registration; a login is not revoked, and expires. */
  close(): void;
}

/** A login the environment holds: its token, whether it made it, where and through which provider, and the token's scrub registration. */
interface Login {
  readonly token: string;
  readonly minted: boolean;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
  readonly release: ScrubRelease;
}

/** What a sign-in came to. */
type SignInResult =
  | { readonly outcome: "signed-in"; readonly login: Login; readonly information: KeyManagerTokenInformation }
  /** The credential refused, or a root login, which the harness never holds. */
  | { readonly outcome: "refused"; readonly reason: "rejected" | "root_token"; readonly message: string }
  /** The key manager could not be asked: the credential stands as it was. */
  | { readonly outcome: Exclude<ProviderFailure["outcome"], "credential-rejected">; readonly message: string };

type Refusal<N extends MethodName> = CommandRejection<ErrorOf<N>["code"]>;

/** The wire error of a sign-in that could not ask the key manager. */
const FAILURE_CODES = { unreachable: "unreachable", sealed: "sealed", "certificate-rejected": "certificate_rejected" } as const;

export const createKeyManagerConnections = (options: KeyManagerConnectionsOptions): KeyManagerConnections => {
  const { log, clock, vault, scrub } = options;
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The logins held, by connection. */
  const logins = new Map<string, Login>();
  /** The scrub registration of each credential held, by connection. */
  const credentials = new Map<string, ScrubRelease>();
  /** When each sign-in from the kept credential under way began, by connection. */
  const signingIn = new Map<string, string>();
  /** Raised by every committed command that changes a connection's credential, login or address: a sign-in begun before records nothing. */
  const epochs = new Map<string, number>();
  let closed = false;

  const epochOf = (connectionId: string): number => epochs.get(connectionId) ?? 0;
  /** A command changed the connection's credential, login or address: a sign-in from the kept credential under way records nothing, and it no longer stands as signing in. */
  const moved = (connectionId: string): void => {
    epochs.set(connectionId, epochOf(connectionId) + 1);
    signingIn.delete(connectionId);
  };

  /** Registers a credential's secrets for its connection, as one release. */
  const registerCredential = (connectionId: string, credential: KeyManagerCredential): ScrubRelease => {
    const releases = secretsOf(credential).map((secret) => scrub.register(secret, { owner: `key-manager:${connectionId}` }));
    return () => {
      for (const release of releases) release();
    };
  };

  const holdCredential = (connectionId: string, release: ScrubRelease | null): void => {
    credentials.get(connectionId)?.();
    if (release === null) credentials.delete(connectionId);
    else credentials.set(connectionId, release);
  };

  /** The line a key manager's own text becomes: registered values and shape rules scrubbed from it. */
  const scrubbed = (message: string): string => scrub.scrubOutput(message);

  /** Lets go of a login: one the environment made is revoked first, while its token is still registered; a token a person gave is only let go. */
  const letGo = async (connectionId: string, login: Login): Promise<void> => {
    try {
      if (!login.minted) return;
      const revoked = await login.provider.revoke(login.target, login.token);
      if (revoked.outcome !== "revoked") console.error(`Revoking the login of the key-manager connection ${connectionId} failed; it expires by itself: ${scrubbed(revoked.message)}`);
    } finally {
      login.release();
    }
  };

  /** Holds `login` as the connection's, letting go of the one it replaces. */
  const holdLogin = (connectionId: string, login: Login): void => {
    const replaced = logins.get(connectionId);
    logins.set(connectionId, login);
    if (replaced !== undefined) void letGo(connectionId, replaced);
  };

  /** Deletes a vault entry a committed command let go of; one left behind is deleted by the next start. */
  const deleteEntry = (entry: string): void => {
    vault.delete(entry).catch((error: unknown) => console.error(`Deleting the vault entry ${entry} failed; the next start deletes it:`, error));
  };

  /** Lets go of everything a connection held once its sign-out or removal has committed: its login, its credential's registration and entry. */
  const forget = (connectionId: string, entry: string | null): void => {
    moved(connectionId);
    const login = logins.get(connectionId);
    logins.delete(connectionId);
    if (login !== undefined) void letGo(connectionId, login);
    holdCredential(connectionId, null);
    if (entry !== null) deleteEntry(entry);
  };

  /** The credential a vault entry holds; null when it is gone or unreadable. */
  const readCredential = async (entry: string): Promise<KeyManagerCredential | null> => {
    try {
      const text = await vault.get(entry);
      if (text === undefined) return null;
      const credential = KeyManagerCredential.safeParse(JSON.parse(text));
      return credential.success ? credential.data : null;
    } catch (error) {
      console.error(`Reading the vault entry ${entry} failed:`, error);
      return null;
    }
  };

  /** Writes `credential` to a new vault entry before the command's transaction, deleted again unless the command is accepted. */
  const store = async (connectionId: string, credential: KeyManagerCredential, context: PrepareContext): Promise<string> => {
    const entry = newEntry(connectionId);
    context.onUndo(() => vault.delete(entry));
    await vault.set(entry, JSON.stringify(credential));
    return entry;
  };

  const statusNow = (kind: KeyManagerStatus["kind"], message: string): KeyManagerStatus => ({ kind, since: clock.now().toISOString(), message });

  const awaitingSignIn = (): KeyManagerStatus => statusNow("awaiting-sign-in", "No credential is on this environment: sign in in Set up, Key manager.");

  const signedInStatus = (provider: KeyManagerProvider, information: KeyManagerTokenInformation): KeyManagerStatus =>
    statusNow("signed-in", information.displayName === "" ? `Signed in to ${PROVIDER_NAMES[provider]}.` : `Signed in to ${PROVIDER_NAMES[provider]} as ${information.displayName}.`);

  /**
   * Signs in at `target` with `credential`: logs in, registering the token as
   * it arrives, then looks it up. A root login is let go and refused.
   */
  const signInWith = async (connectionId: string, provider: ConnectionProvider, target: SignInTarget, credential: KeyManagerCredential): Promise<SignInResult> => {
    const failed = (failure: ProviderFailure): SignInResult =>
      failure.outcome === "credential-rejected" ? { outcome: "refused", reason: "rejected", message: scrubbed(failure.message) } : { outcome: failure.outcome, message: scrubbed(failure.message) };
    const logged = await provider.logIn(target, credential);
    if (logged.outcome !== "logged-in") return failed(logged);
    const login: Login = { token: logged.token, minted: logged.minted, provider, target, release: scrub.register(logged.token, { owner: `key-manager:${connectionId}:login` }) };
    const found = await provider.lookUp(target, logged.token);
    if (found.outcome !== "found") {
      await letGo(connectionId, login);
      return failed(found);
    }
    if (found.root) {
      await letGo(connectionId, login);
      return { outcome: "refused", reason: "root_token", message: `${target.address} signs this credential in with the root policy, which the harness never holds: give it one without root.` };
    }
    return { outcome: "signed-in", login, information: found.information };
  };

  /** A record as it stands now: signing in while a sign-in from the kept credential is under way. */
  const standing = (record: KeyManagerConnectionRecord): KeyManagerConnectionRecord => {
    const since = signingIn.get(record.id);
    return since === undefined ? record : { ...record, status: { kind: "signing-in", since, message: `Signing in to ${PROVIDER_NAMES[record.provider]} at ${record.address}.` } };
  };

  const recordOf = (connectionId: string): KeyManagerConnectionRecord => {
    const held = liveConnection(reader, connectionId);
    if (held === null) throw new Error(`The key-manager connection ${connectionId} is not in the store after a command applied to it.`);
    return standing(held.record);
  };

  const notFound = (connectionId: string) =>
    ({ code: "not_found", message: `No key-manager connection ${connectionId} is on this environment.`, data: { kind: "key_manager_connection", connectionId } }) as const;

  const conflict = (reason: string, message: string, data: Record<string, string>) => ({ code: "conflict", message, data: { reason, ...data } }) as const;

  /** Another connection of `provider` at `address`, refused `connection_exists`; null for none. */
  const addressTaken = (provider: KeyManagerProvider, address: string, except?: string) => {
    const holder = addressHolder(reader, provider, address);
    return holder === null || holder === except
      ? null
      : conflict("connection_exists", `A ${PROVIDER_NAMES[provider]} connection to ${address} is on this environment already.`, { provider, address, connectionId: holder });
  };

  /** Why an add cannot go ahead as the store is now: an id used before, or the provider and address held; null when it can. */
  const addRefusal = (connectionId: string, provider: KeyManagerProvider, address: string): Refusal<"keyManagers.connections.add"> | null => {
    if (connectionEver(reader, connectionId)) return conflict("exists", `A key-manager connection ${connectionId} was added already.`, { connectionId });
    return addressTaken(provider, address);
  };

  const verificationFailed = (connectionId: string, refused: Extract<SignInResult, { outcome: "refused" }>, nothing: string) =>
    ({ code: "verification_failed", message: `${refused.message} ${nothing}`, data: { connectionId, reason: refused.reason } }) as const;

  /** The refusal of a sign-in that could not ask the key manager: `unreachable`, `sealed` or `certificate_rejected`. */
  const couldNotAsk = (connectionId: string, result: Extract<SignInResult, { outcome: keyof typeof FAILURE_CODES }>) =>
    ({ code: FAILURE_CODES[result.outcome], message: `${result.message} Nothing was changed.`, data: { connectionId } }) as const;

  const providerUnavailable = (provider: KeyManagerProvider) =>
    ({
      code: "provider_unavailable",
      message: `This environment cannot sign in to ${PROVIDER_NAMES[provider]} yet: add the connection without a credential, and sign it in with a version that can. Nothing was stored.`,
      data: { provider },
    }) as const;

  /** A command's rejection, answered as the handler it prepares. */
  const rejecting =
    <N extends MethodName>(rejected: Refusal<N>) =>
    (): CommandAnswer<ResultOf<N>, ErrorOf<N>["code"]> => ({ aggregate: stream, rejected });

  /** The pinned CA a command gives, checked: a PEM certificate, for an https address alone. */
  const checkedCa = (ca: string | null, address: string, path: readonly string[]): string | null => {
    if (ca === null) return null;
    if (!address.startsWith("https://")) invalid(path, "A CA is pinned only for an https address.");
    try {
      new X509Certificate(ca);
    } catch {
      invalid(path, "The CA is no PEM certificate.");
    }
    return ca;
  };

  /** The mount a method signs in at: the one given, else the method's name; a token's is always OpenBao's token store. */
  const mountFor = (method: KeyManagerAuthMethod, given: string | undefined): string => {
    const mount = given ?? method;
    if (method === "token" && mount !== "token") invalid(["mount"], "A token signs in at OpenBao's token store, whose mount is token.");
    return mount;
  };

  /** The username a method signs in as: userpass needs one, given or held; no other method takes one. */
  const usernameFor = (method: KeyManagerAuthMethod, given: string | undefined, held: string | null): string | null => {
    if (method === "userpass") return given ?? held ?? invalid(["username"], "A userpass login needs a username.");
    if (given !== undefined) invalid(["username"], "Only a userpass login takes a username.");
    return null;
  };

  /** OpenBao's settings of an add: its CA, method, mount, username and token role; all null for another provider, which takes none. */
  const settingsOf = (params: ParamsOf<"keyManagers.connections.add">, address: string) => {
    if (params.provider !== "openbao") {
      for (const field of ["ca", "method", "mount", "username", "tokenRole"] as const) {
        if (params[field] !== undefined) invalid([field], `${field} is OpenBao's: a ${PROVIDER_NAMES[params.provider]} connection takes none.`);
      }
      return { ca: null, method: null, mount: null, username: null, tokenRole: null };
    }
    const method = params.method ?? params.credential?.method ?? invalid(["method"], "Name how the connection signs in: approle, userpass or token.");
    if (params.credential !== undefined && params.credential.method !== method) {
      invalid(["credential", "method"], `The credential is for ${params.credential.method}, and the connection signs in by ${method}.`);
    }
    return {
      ca: checkedCa(params.ca ?? null, address, ["ca"]),
      method,
      mount: mountFor(method, params.mount),
      username: usernameFor(method, params.username, null),
      tokenRole: params.tokenRole ?? null,
    };
  };

  /** Where a connection signs in, at `address` with `ca`; null for one with no auth method, another provider's than OpenBao. */
  const targetOf = (record: KeyManagerConnectionRecord, address = record.address, ca = record.ca): SignInTarget | null =>
    record.method === null || record.mount === null ? null : { address, ca, method: record.method, mount: record.mount, username: record.username };

  /** The fields a first sign-in sets beside its outcome: the ticks preset to the login's policies, and whether it now injects. */
  const firstSignIn = (record: KeyManagerConnectionRecord, information: KeyManagerTokenInformation): Pick<KeyManagerConnectionSignedInPayload, "ticks" | "injects"> => ({
    ...(record.ticks === null && { ticks: information.policies }),
    ...(!record.injects && !injecting(reader, record.provider) && { injects: true as const }),
  });

  const add: KeyManagerConnections["add"] = {
    async prepare(params, context) {
      const connectionId = params.connectionId.toLowerCase();
      const given = params.credential;
      // Registered as it arrives, before anything can answer with it; let go unless the add is accepted.
      const arrival = given === undefined ? null : registerCredential(connectionId, given);
      if (arrival !== null) context.onUndo(arrival);
      const address = httpOriginOf(params.address) ?? invalid(["address"], "The address is no https or http URL of a key manager: give its origin, as https://bao.example.com:8200.");
      if (params.importedFrom !== undefined && params.copiedFrom !== undefined) invalid(["importedFrom"], "A connection is copied or imported, not both.");
      if (params.importedFrom !== undefined && given !== undefined) invalid(["credential"], "An imported connection signs in on this environment: the import sends no credential.");
      const settings = settingsOf(params, address);
      const basePathRefused = params.basePath === undefined ? null : basePathProblem(params.provider, params.basePath);
      if (basePathRefused !== null) invalid(["basePath"], basePathRefused);
      const provider = PROVIDERS[params.provider];
      if (given !== undefined && provider === undefined) return rejecting<"keyManagers.connections.add">(providerUnavailable(params.provider));
      /** The connection the state import made from the same source id, which a repeated import is answered with. */
      const imported = () => (params.importedFrom === undefined ? null : importedHolder(reader, params.importedFrom));
      const doomed = imported() === null ? addRefusal(connectionId, params.provider, address) : null;
      if (doomed !== null) return rejecting<"keyManagers.connections.add">(doomed);

      let status = awaitingSignIn();
      let signed: Extract<SignInResult, { outcome: "signed-in" }> | null = null;
      let entry: string | null = null;
      if (given !== undefined && provider !== undefined && settings.method !== null && settings.mount !== null) {
        const target: SignInTarget = { address, ca: settings.ca, method: settings.method, mount: settings.mount, username: settings.username };
        const result = await signInWith(connectionId, provider, target, given);
        if (result.outcome === "refused") return rejecting<"keyManagers.connections.add">(verificationFailed(connectionId, result, "Nothing was stored."));
        if (result.outcome === "signed-in") {
          context.onUndo(() => letGo(connectionId, result.login));
          signed = result;
          status = signedInStatus(params.provider, result.information);
        } else {
          status = statusNow(result.outcome, result.message);
        }
        entry = await store(connectionId, given, context);
      }

      return (_params, command) => {
        // Read again in the transaction: another command may have taken the id or the address, or imported the same source.
        const existing = imported();
        if (existing !== null) return { aggregate: stream, result: { connection: recordOf(existing) } };
        const refused = addRefusal(connectionId, params.provider, address);
        if (refused !== null) return { aggregate: stream, rejected: refused };
        const payload: KeyManagerConnectionAddedPayload = {
          connectionId,
          provider: params.provider,
          label: params.label,
          address,
          ...settings,
          ticks: params.ticks ?? signed?.information.policies ?? null,
          basePath: params.basePath ?? null,
          injects: signed !== null && !injecting(reader, params.provider),
          status,
          tokenInformation: signed?.information ?? null,
          credential: entry,
          copiedFrom: params.copiedFrom ?? null,
          importedFrom: params.importedFrom ?? null,
        };
        log.append(stream, [{ type: "key-manager.connection.added", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => {
          holdCredential(connectionId, arrival);
          if (signed !== null) holdLogin(connectionId, signed.login);
        });
        return { aggregate: stream, result: { connection: recordOf(connectionId) } };
      };
    },
  };

  const signIn: KeyManagerConnections["signIn"] = {
    async prepare(params, context) {
      const connectionId = params.connectionId.toLowerCase();
      const given = params.credential;
      const arrival = registerCredential(connectionId, given);
      context.onUndo(arrival);
      const held = liveConnection(reader, connectionId);
      if (held === null) return rejecting<"keyManagers.connections.signIn">(notFound(connectionId));
      const { record } = held;
      const provider = PROVIDERS[record.provider];
      if (provider === undefined) return rejecting<"keyManagers.connections.signIn">(providerUnavailable(record.provider));
      const method = given.method;
      const mount = mountFor(method, params.mount ?? (method === record.method ? (record.mount ?? undefined) : undefined));
      const username = usernameFor(method, params.username, record.username);
      const target: SignInTarget = { address: record.address, ca: record.ca, method, mount, username };

      const result = await signInWith(connectionId, provider, target, given);
      if (result.outcome === "refused") return rejecting<"keyManagers.connections.signIn">(verificationFailed(connectionId, result, "Nothing was changed."));
      if (result.outcome !== "signed-in") return rejecting<"keyManagers.connections.signIn">(couldNotAsk(connectionId, result));
      context.onUndo(() => letGo(connectionId, result.login));
      const entry = await store(connectionId, given, context);

      return (_params, command) => {
        const current = liveConnection(reader, connectionId);
        if (current === null) return { aggregate: stream, rejected: notFound(connectionId) };
        const now = current.record;
        const payload: KeyManagerConnectionSignedInPayload = {
          connectionId,
          status: signedInStatus(now.provider, result.information),
          tokenInformation: result.information,
          credential: entry,
          ...(method !== now.method && { method }),
          ...(mount !== now.mount && { mount }),
          ...(username !== now.username && { username }),
          ...firstSignIn(now, result.information),
        };
        log.append(stream, [{ type: "key-manager.connection.signed-in", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => {
          moved(connectionId);
          holdCredential(connectionId, arrival);
          holdLogin(connectionId, result.login);
          if (current.credential !== null) deleteEntry(current.credential);
        });
        return { aggregate: stream, result: { connection: recordOf(connectionId) } };
      };
    },
  };

  /** The label, address, CA and token role an update gives that the record does not hold already. */
  const changesOf = (record: KeyManagerConnectionRecord, wanted: Pick<KeyManagerConnectionRecord, "label" | "address" | "ca" | "tokenRole">): Omit<KeyManagerConnectionUpdatedPayload, "connectionId"> => ({
    ...(wanted.label !== record.label && { label: wanted.label }),
    ...(wanted.address !== record.address && { address: wanted.address }),
    ...(wanted.ca !== record.ca && { ca: wanted.ca }),
    ...(wanted.tokenRole !== record.tokenRole && { tokenRole: wanted.tokenRole }),
  });

  const update: KeyManagerConnections["update"] = {
    prepare(params, context) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return rejecting<"keyManagers.connections.update">(notFound(connectionId));
      const { record } = held;
      if (record.provider !== "openbao") {
        if (params.ca !== undefined) invalid(["ca"], `ca is OpenBao's: a ${PROVIDER_NAMES[record.provider]} connection takes none.`);
        if (params.tokenRole !== undefined) invalid(["tokenRole"], `tokenRole is OpenBao's: a ${PROVIDER_NAMES[record.provider]} connection takes none.`);
      }
      const address =
        params.address === undefined ? record.address : (httpOriginOf(params.address) ?? invalid(["address"], "The address is no https or http URL of a key manager: give its origin."));
      const ca = checkedCa(params.ca === undefined ? record.ca : params.ca, address, [params.ca === undefined ? "address" : "ca"]);
      const wanted = { label: params.label ?? record.label, address, ca, tokenRole: params.tokenRole === undefined ? record.tokenRole : params.tokenRole };
      const taken = address === record.address ? null : addressTaken(record.provider, address, connectionId);
      if (taken !== null) return rejecting<"keyManagers.connections.update">(taken);

      /** The handler, given the login a new address or CA was signed in to, if one was. */
      const apply =
        (signed: Extract<SignInResult, { outcome: "signed-in" }> | null) =>
        (_params: unknown, command: CommandContext): CommandAnswer<ResultOf<"keyManagers.connections.update">, ErrorOf<"keyManagers.connections.update">["code"]> => {
          const current = liveConnection(reader, connectionId);
          if (current === null) return { aggregate: stream, rejected: notFound(connectionId) };
          const now = current.record;
          const refused = wanted.address === now.address ? null : addressTaken(now.provider, wanted.address, connectionId);
          if (refused !== null) return { aggregate: stream, rejected: refused };
          const changes = changesOf(now, wanted);
          if (Object.keys(changes).length === 0) {
            if (signed !== null) command.tx.afterCommit(() => void letGo(connectionId, signed.login));
            return { aggregate: stream, result: { connection: standing(now) } };
          }
          const at = { tx: command.tx, actor: command.actor, commandId: command.commandId };
          log.append(stream, [{ type: "key-manager.connection.updated", payload: { connectionId, ...changes } }], at);
          if (signed !== null) {
            const payload: KeyManagerConnectionSignedInPayload = {
              connectionId,
              status: signedInStatus(now.provider, signed.information),
              tokenInformation: signed.information,
              ...firstSignIn(now, signed.information),
            };
            log.append(stream, [{ type: "key-manager.connection.signed-in", payload }], at);
            command.tx.afterCommit(() => {
              moved(connectionId);
              holdLogin(connectionId, signed.login);
            });
          }
          return { aggregate: stream, result: { connection: recordOf(connectionId) } };
        };

      // A new address or CA is signed in against first, with the credential held; a connection holding none changes at once.
      const target = targetOf(record, address, ca);
      const provider = PROVIDERS[record.provider];
      const entry = held.credential;
      if ((address === record.address && ca === record.ca) || entry === null || target === null || provider === undefined) return apply(null);
      return (async () => {
        const credential = await readCredential(entry);
        if (credential === null) return apply(null);
        const result = await signInWith(connectionId, provider, target, credential);
        if (result.outcome === "refused") return rejecting<"keyManagers.connections.update">(verificationFailed(connectionId, result, "Nothing was changed."));
        if (result.outcome !== "signed-in") return rejecting<"keyManagers.connections.update">(couldNotAsk(connectionId, result));
        context.onUndo(() => letGo(connectionId, result.login));
        return apply(result);
      })();
    },
  };

  /** Signs a connection in from its kept credential, as the environment does after a start, recording the outcome as its own. */
  const signInFromVault = async (record: KeyManagerConnectionRecord, entry: string, provider: ConnectionProvider, target: SignInTarget): Promise<void> => {
    const connectionId = record.id;
    const epoch = epochOf(connectionId);
    const since = clock.now().toISOString();
    signingIn.set(connectionId, since);
    try {
      const credential = await readCredential(entry);
      const result: SignInResult =
        credential === null
          ? { outcome: "refused", reason: "rejected", message: "The environment's vault holds no credential for this connection." }
          : await signInWith(connectionId, provider, target, credential);
      const signed = result.outcome === "signed-in" ? result : null;
      const recorded =
        !closed &&
        epochOf(connectionId) === epoch &&
        log.atomically((tx) => {
          const current = liveConnection(reader, connectionId);
          if (current === null || current.credential !== entry) return false;
          const status =
            result.outcome === "signed-in"
              ? signedInStatus(current.record.provider, result.information)
              : result.outcome === "refused"
                ? statusNow("credential-rejected", `${result.message} Sign in again in Set up, Key manager.`)
                : statusNow(result.outcome, result.message);
          const payload: KeyManagerConnectionSignedInPayload = {
            connectionId,
            status,
            tokenInformation: signed?.information ?? null,
            ...(signed !== null && firstSignIn(current.record, signed.information)),
          };
          log.append(stream, [{ type: "key-manager.connection.signed-in", payload }], { tx, actor: KEY_MANAGER_ACTOR });
          return true;
        });
      if (signed === null) return;
      if (recorded) holdLogin(connectionId, signed.login);
      else await letGo(connectionId, signed.login);
    } catch (error) {
      console.error(`Signing the key-manager connection ${connectionId} in from its kept credential failed:`, error);
    } finally {
      if (signingIn.get(connectionId) === since) signingIn.delete(connectionId);
    }
  };

  return {
    async start() {
      const entries = new Set<string>();
      for (const { record, credential } of listConnections(reader)) {
        if (credential === null) continue;
        entries.add(credential);
        const held = await readCredential(credential);
        if (held !== null) holdCredential(record.id, registerCredential(record.id, held));
      }
      try {
        for (const key of await vault.keys()) if (key.startsWith(VAULT_PREFIX) && !entries.has(key)) await vault.delete(key);
      } catch (error) {
        console.error("Deleting the vault entries of key-manager connections that are gone failed; the next start tries again:", error);
      }
    },

    startSigningIn() {
      for (const { record, credential } of listConnections(reader)) {
        const provider = PROVIDERS[record.provider];
        const target = targetOf(record);
        if (credential !== null && provider !== undefined && target !== null) void signInFromVault(record, credential, provider, target);
      }
    },

    list: () => listConnections(reader).map((held: StoredConnection) => standing(held.record)),

    add,

    signIn,

    update,

    signOut(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      if (held.credential === null) return { aggregate: stream, result: { connection: standing(held.record) } };
      const status = statusNow("awaiting-sign-in", "Signed out: sign in again in Set up, Key manager.");
      log.append(stream, [{ type: "key-manager.connection.signed-out", payload: { connectionId, status } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      command.tx.afterCommit(() => forget(connectionId, held.credential));
      return { aggregate: stream, result: { connection: recordOf(connectionId) } };
    },

    remove(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      log.append(stream, [{ type: "key-manager.connection.removed", payload: { connectionId } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      command.tx.afterCommit(() => forget(connectionId, held.credential));
      return { aggregate: stream, result: { connectionId } };
    },

    close() {
      closed = true;
      for (const login of logins.values()) login.release();
      logins.clear();
      for (const release of credentials.values()) release();
      credentials.clear();
    },
  };
};

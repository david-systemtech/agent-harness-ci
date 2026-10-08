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
  type KeyManagerConnectionVerifiedPayload,
  type KeyManagerProvider,
  type KeyManagerReferenceHolder,
  type KeyManagerStatus,
  type KeyManagerTokenInformation,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@agent-harness/contracts";
import type { ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PrepareContext, PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { createBackgroundWork } from "./background.js";
import { basePathProblem, providerSuggestion } from "./base-path.js";
import { addressHolder, connectionEver, importedHolder, injecting, listConnections, liveConnection, type StoredConnection } from "./connection-store.js";
import { createLogins, letGo as letGoOf, type Login, type LoginToken } from "./logins.js";
import { createBitwardenProvider } from "./bitwarden.js";
import type { BitwardenSdkLoader } from "./bitwarden-sdk.js";
import { createDopplerProvider } from "./doppler.js";
import { createOnePasswordProvider } from "./onepassword.js";
import type { OnePasswordSdk } from "./onepassword-sdk.js";
import { createOpenBaoProvider } from "./openbao.js";
import { KEY_MANAGER_BUDGET_MS, PROVIDER_NAMES, providerUnavailableLine, type ConnectionProvider, type LoginFailure, type SignInTarget, type VerifyAnswer } from "./provider.js";
import { createRunTokens } from "./run-tokens.js";
import { createVerificationSchedule } from "./verifier.js";

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
 *   while held, by the login scheduler (`logins.ts`, #369), which renews it,
 *   says when it is due to be replaced, and counts the connection's login
 *   generation. After the startup gate every connection with a credential
 *   signs in at once from it, `signing-in` until its outcome is recorded, so
 *   a restart logs in again.
 * - **A login the environment made is revoked** when it is signed out or
 *   removed, and when the command that made it is not accepted; one replaced
 *   is revoked once no run token minted from it is held. A token a person
 *   gave is their own, never revoked, only let go.
 * - **A replaced or removed credential's entry** is deleted once its command
 *   has committed; a start deletes every key-manager entry no connection
 *   holds, whatever an interrupted deletion left.
 * - **One connection per provider and address**, and the first of a
 *   provider signed in while none injects does (`injects`), until it is
 *   signed out or removed; the ticks are preset to every policy of the
 *   login at its first sign-in, and `setPolicies` ticks a subset of them.
 * - **Verification** (#366) runs on the schedule `verifier.ts` keeps, one at
 *   a time per connection within the budget (ADR 0031's ten seconds), past
 *   which the connection is `unreachable`. It asks the key manager with the
 *   login held; with none held, a login the environment made that is due
 *   (#369: a third of its maximum life left), or one whose token OpenBao no
 *   longer knows (it lived out its time to live), it signs in from the kept
 *   credential first and records that as the environment's own sign-in: a
 *   failure stands as the status its category gives. A token a person gave
 *   that OpenBao no longer knows is
 *   `expired` once past the expiry its lookup gave, else
 *   `credential-rejected`. What changed of the status, token information,
 *   policies or `canMint` is recorded as `key-manager.connection.verified`,
 *   as `system:key-manager`; a verification that finds nothing new appends
 *   nothing, and when each connection was last verified is kept beside its
 *   record, in memory, as the forge's verified-at times are. Every line a
 *   key manager's text becomes passes the scrub registry first (#363).
 * - **References** (#370) are read through `readable`: a connection's
 *   record as it stands and the login held for it, which the registry
 *   (`references.ts`) reads with, never a run token. A connection a
 *   reference names is removed only with `force`, else `conflict` reason
 *   `referenced` naming its holders, which the services holding references
 *   answer (`referenceHolders`).
 * - **The base path** (#371) is set by `setBasePath`, held to the base
 *   path's rule (`base-path.ts`). While none is set, a verification that
 *   finds the login signed in asks the provider for one to suggest, within
 *   the budget again; the suggestion is kept in memory beside the record,
 *   as the verified-at times are, and answered on it until a base is set.
 *   It is asked before anything the verification found is recorded (#689),
 *   so a verification is seen whole, and only as it ends: a client reading
 *   the records on its event reads the suggestion, and one that sees what it
 *   recorded sees the next verification already scheduled from its end.
 */

/** The environment's own sign-ins' actor. */
export const KEY_MANAGER_ACTOR = formatActor({ kind: "system", id: "key-manager" });

/** What every vault entry holding a key-manager credential is named with. */
const VAULT_PREFIX = "key-manager:";

/** A new vault entry for a credential given to `connectionId`: one per credential, so a replacement never overwrites the one it replaces. */
const newEntry = (connectionId: string): string => `${VAULT_PREFIX}${connectionId}:${randomUUID()}`;

/** How a holder of a reference is named to people. */
const HOLDER_KINDS: Record<KeyManagerReferenceHolder["kind"], string> = { "forge-account": "forge account", endpoint: "webhook endpoint", bank: "bank" };

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
  /** How long one verification may take, on the wall clock; preset `KEY_MANAGER_BUDGET_MS`. */
  readonly budgetMs?: number;
  readonly bitwardenSdk?: BitwardenSdkLoader;
  /** The environment's id: the id of its stream, where the connections' events go. */
  readonly environmentId: string;
  /** The vault as the environment holds it: every entry registered with the scrub registry while it is held. */
  readonly vault: Vault;
  readonly scrub: ScrubRegistry;
  /** What holds a reference to the connection: the forge accounts whose credential is one. Preset: nothing. */
  readonly referenceHolders?: (connectionId: string) => readonly KeyManagerReferenceHolder[];
  /** The data directory's key-manager CLI directory, where the configuration the injected CLIs are pointed at is kept (#368). */
  readonly cliDirectory: string;
  /** The 1Password SDK the 1Password provider signs in through (#378): the official one; tests give a scripted double. */
  readonly onePasswordSdk: OnePasswordSdk;
}

/** A login the environment holds for a connection, as a reference is read with it: its token, and the provider and target it signed in through. */
export interface HeldLogin {
  readonly token: string;
  readonly provider: ConnectionProvider;
  readonly target: SignInTarget;
}

/** A connection as references are read through it: its record as it stands now, and the login held for it, null while none is. */
export interface ReadableConnection {
  readonly record: KeyManagerConnectionRecord;
  readonly login: HeldLogin | null;
}

export interface KeyManagerConnections {
  /** Registers every credential the vault holds, and deletes the key-manager entries no connection holds; startup runs it once, before the wire opens. */
  start(): Promise<void>;
  /** After startup's gate: every connection with a credential signs in from it at once, and is verified on the clock after, then every fifteen minutes. */
  startSigningInAndVerifying(): void;
  /** The connections, in the order they were added, each as it stands now, with when it was last verified. */
  list(): KeyManagerConnectionRecord[];
  /** `keyManagers.connections.verify`: verifies one connection now, or every one, joining one running, and answers every record after; `not_found` for one the environment does not hold. */
  verify(connectionId?: string): Promise<KeyManagerConnectionRecord[]>;
  /**
   * `keyManagers.connections.add`, prepared: the wire's, and the state
   * import's and the bulk copy's in process, which apply the handler its
   * prepare answers inside a command of their own.
   */
  readonly add: PreparedCommand<"keyManagers.connections.add">;
  /** Read-only import exclusion: an occupied id must describe exactly this connection. */
  canImport(params: Omit<ParamsOf<"keyManagers.connections.add">, "credential">): boolean;
  /** Carries a record with no credential, checking the id again inside its item transaction. */
  importRecord(params: Omit<ParamsOf<"keyManagers.connections.add">, "credential">, context: CommandContext): CommandAnswer<{ readonly targetId: string; readonly carried: boolean }>;

  readonly signIn: PreparedCommand<"keyManagers.connections.signIn">;
  readonly update: PreparedCommand<"keyManagers.connections.update">;
  readonly setPolicies: MethodHandler<"keyManagers.connections.setPolicies">;
  readonly setBasePath: MethodHandler<"keyManagers.connections.setBasePath">;
  readonly setInjected: MethodHandler<"keyManagers.connections.setInjected">;
  readonly signOut: MethodHandler<"keyManagers.connections.signOut">;
  readonly remove: MethodHandler<"keyManagers.connections.remove">;
  /** The connection `connectionId` as references are read through it; null for one the environment does not hold. */
  readable(connectionId: string): ReadableConnection | null;
  /** The key managers' part of every provider process and terminal (#368): the injecting connections' blocks and each holder's run tokens. */
  readonly processEnvironment: ProcessEnvironmentSupplier;
  /**
   * Settles once every renewal, verification, sign-in and revocation the
   * connections took up off any request has ended, with what each took up in
   * turn (#745): what a test on a held clock waits on after it moves the
   * clock on, before it looks.
   */
  settled(): Promise<void>;
  /** Stops the sign-ins and verifications under way from recording anything, and lets go of every login and credential registration; a login is not revoked, and expires. */
  close(): void;
}

/** Why the key manager could not be asked: the credential stands as it was. */
type CouldNotAsk = Exclude<LoginFailure["outcome"], "credential-rejected">;

/** What a sign-in came to. */
type SignInResult =
  | { readonly outcome: "signed-in"; readonly login: Login; readonly information: KeyManagerTokenInformation }
  /** The credential refused, or a root login, which the harness never holds. */
  | { readonly outcome: "refused"; readonly reason: "rejected" | "root_token"; readonly message: string }
  /** The key manager could not be asked: the credential stands as it was. */
  | { readonly outcome: CouldNotAsk; readonly message: string };

type Refusal<N extends MethodName> = CommandRejection<ErrorOf<N>["code"]>;

/** The wire error of a sign-in that could not ask the key manager: a key manager asking the harness to slow down could not answer now. */
const FAILURE_CODES = { "provider-unavailable": "provider_unavailable", unreachable: "unreachable", sealed: "sealed", "certificate-rejected": "certificate_rejected", "rate-limited": "unreachable" } as const;

/** A refusal's raw words as one line of details. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A sign-in the key manager refused, as setup-copy.md §5.7 says it: a root login for that alone, any other the details it was given. */
const refusedLine = (provider: KeyManagerProvider, reason: "rejected" | "root_token"): string =>
  reason === "root_token" ? "Use a token that is not the root token. agent-harness never uses root." : `${PROVIDER_NAMES[provider]} did not accept these details. Check them and try again.`;

/** A sign-in that could not ask the key manager at `address`, as setup-copy.md §5.7 says it: one asking the harness to slow down could not be reached now. */
const couldNotAskLine = (provider: KeyManagerProvider, address: string, outcome: Exclude<CouldNotAsk, "provider-unavailable">): string => {
  if (outcome === "sealed") return `${PROVIDER_NAMES[provider]} is locked (sealed). Unlock it, then connect.`;
  if (outcome === "certificate-rejected") return "agent-harness does not trust this site's certificate.";
  return `agent-harness could not reach ${address}. Check the address.`;
};

/** The status a connection the key manager could not be asked about stands in: one asking the harness to slow down is unreachable for now. */
const STATUS_OF: Record<CouldNotAsk, KeyManagerStatus["kind"]> = { "provider-unavailable": "provider-unavailable", unreachable: "unreachable", sealed: "sealed", "certificate-rejected": "certificate-rejected", "rate-limited": "unreachable" };

/** What one verification found: the key manager's answer with the login it asked with, or the status it found the connection in. */
type Checked =
  | {
      readonly outcome: "verified";
      readonly answer: Extract<VerifyAnswer, { readonly outcome: "verified" }>;
      readonly login: Login;
      /** Whether the verification signed in to ask: its login is held only once what it found is recorded. */
      readonly fresh: boolean;
    }
  /** The status it found the connection in: credential-rejected, expired, unreachable, sealed or certificate-rejected. */
  | { readonly outcome: "failed"; readonly status: KeyManagerStatus };

/** `2026-09-24 01:00 UTC`: an instant to the minute, for a line a person reads. */
const minute = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/** Whether a verification changed what the token information says, beside the time it has left, which moves with the clock. */
const sameInformation = (one: KeyManagerTokenInformation | null, other: KeyManagerTokenInformation | null): boolean =>
  JSON.stringify(one === null ? null : { ...one, ttlSeconds: 0 }) === JSON.stringify(other === null ? null : { ...other, ttlSeconds: 0 });

export const createKeyManagerConnections = (options: KeyManagerConnectionsOptions): KeyManagerConnections => {
  const { log, clock, vault, scrub } = options;
  const budgetMs = options.budgetMs ?? KEY_MANAGER_BUDGET_MS;
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  /** The providers this environment signs in to, each keeping what it learns of its key managers for the environment's life. */
  const providers: Partial<Record<KeyManagerProvider, ConnectionProvider>> = {
    openbao: createOpenBaoProvider(),
    doppler: createDopplerProvider(),
    onepassword: createOnePasswordProvider(options.onePasswordSdk),
    bitwarden: createBitwardenProvider(options.bitwardenSdk),
  };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The scrub registration of each credential held, by connection. */
  const credentials = new Map<string, ScrubRelease>();
  /** When each sign-in from the kept credential under way began, by connection. */
  const signingIn = new Map<string, string>();
  /** The startup's sign-in of each connection while it runs: a verification waits for it. */
  const startupSignIns = new Map<string, Promise<void>>();
  /** What the connections, their logins and their run tokens do off any request. */
  const background = createBackgroundWork();
  /** When each connection was last verified, whatever it found: beside the record, which keeps only the time of the last one that changed something. */
  const verifiedTimes = new Map<string, string>();
  /** The base path each connection's provider suggested at its last verification that asked, while it has none (#371). */
  const suggestions = new Map<string, string | null>();
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

  /** Lets go of a login no command or sign-in holds: one the environment made is revoked first, while its token is still registered. */
  const letGo = (connectionId: string, login: LoginToken): Promise<void> => letGoOf(connectionId, login, scrub);

  /** The logins held, renewed and replaced on the clock; a login due, or one the key manager no longer knows, is verified again at once, which signs in again. */
  const logins = createLogins({ clock, scrub, budgetMs, background, due: (connectionId) => void schedule.verifyAgain(connectionId) });

  /** Deletes a vault entry a committed command let go of; one left behind is deleted by the next start. */
  const deleteEntry = (entry: string): void => {
    vault.delete(entry).catch((error: unknown) => console.error(`Deleting the vault entry ${entry} failed; the next start deletes it:`, error));
  };

  /** Lets go of everything a connection held once its sign-out or removal has committed: its login, its credential's registration and entry. */
  const forget = (connectionId: string, entry: string | null): void => {
    moved(connectionId);
    suggestions.delete(connectionId);
    runTokens.revokeAll(connectionId);
    logins.forget(connectionId);
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

  /**
   * The status of a connection whose credential the key manager refused: a
   * token a person gave, past the expiry its lookup gave, lived out its
   * maximum life (`expired`); any other credential is rejected.
   */
  const refusedStatus = (record: KeyManagerConnectionRecord, message: string): KeyManagerStatus => {
    const expiry = record.method === "token" ? (record.tokenInformation?.expiresAt ?? null) : null;
    if (expiry !== null && clock.now().getTime() >= Date.parse(expiry)) {
      return statusNow("expired", `The token this connection signed in with expired at ${minute(expiry)}, the end of its life: sign in again with a new token in Set up, Key manager.`);
    }
    return statusNow("credential-rejected", `${message} Sign in again in Set up, Key manager.`);
  };

  const signedInStatus = (provider: KeyManagerProvider, information: KeyManagerTokenInformation): KeyManagerStatus =>
    statusNow("signed-in", information.displayName === "" ? `Signed in to ${PROVIDER_NAMES[provider]}.` : `Signed in to ${PROVIDER_NAMES[provider]} as ${information.displayName}.`);

  /**
   * Signs in at `target` with `credential`: logs in, registering the token as
   * it arrives, then looks it up. A root login is let go and refused.
   */
  const signInWith = async (connectionId: string, provider: ConnectionProvider, target: SignInTarget, credential: KeyManagerCredential, signal?: AbortSignal): Promise<SignInResult> => {
    const failed = (failure: LoginFailure): SignInResult =>
      failure.outcome === "credential-rejected" ? { outcome: "refused", reason: "rejected", message: scrubbed(failure.message) } : { outcome: failure.outcome, message: scrubbed(failure.message) };
    const logged = await provider.logIn(target, credential, signal);
    if (logged.outcome !== "logged-in") return failed(logged);
    const token: LoginToken = { token: logged.token, minted: logged.minted, provider, target, release: scrub.register(logged.token, { owner: `key-manager:${connectionId}:login` }) };
    const found = await provider.lookUp(target, logged.token, signal);
    if (found.outcome !== "found") {
      await letGo(connectionId, token);
      return failed(found);
    }
    if (found.root) {
      await letGo(connectionId, token);
      return { outcome: "refused", reason: "root_token", message: `${target.address} signs this credential in with the root policy, which the harness never holds: give it one without root.` };
    }
    return { outcome: "signed-in", login: { ...token, information: found.information, life: found.life }, information: found.information };
  };

  /** `record` with when it was last verified, the later of its own time and the one kept beside it, and the base path suggested while it has none. */
  const seen = (record: KeyManagerConnectionRecord): KeyManagerConnectionRecord => {
    const at = verifiedTimes.get(record.id);
    const verified = at === undefined || (record.verifiedAt !== null && record.verifiedAt >= at) ? record : { ...record, verifiedAt: at };
    return record.basePath === null ? { ...verified, suggestedBasePath: suggestions.get(record.id) ?? null } : verified;
  };

  /** A record as it stands now: signing in while a sign-in from the kept credential is under way, and with when it was last verified. */
  const standing = (record: KeyManagerConnectionRecord): KeyManagerConnectionRecord => {
    const since = signingIn.get(record.id);
    return seen(since === undefined ? record : { ...record, status: { kind: "signing-in", since, message: `Signing in to ${PROVIDER_NAMES[record.provider]} at ${record.address}.` } });
  };

  /** The record a command left: a sign-in, a sign-out or a new address settles the connection, whatever sign-in from the kept credential still runs. */
  const settledRecordOf = (connectionId: string): KeyManagerConnectionRecord => {
    const held = liveConnection(reader, connectionId);
    if (held === null) throw new Error(`The key-manager connection ${connectionId} is not in the store after a command applied to it.`);
    return seen(held.record);
  };

  /** The record a command left, as it stands now. */
  const recordOf = (connectionId: string): KeyManagerConnectionRecord => standing(settledRecordOf(connectionId));

  const notFound = (connectionId: string) =>
    ({ code: "not_found", message: `No key-manager connection ${connectionId} is on this environment.`, data: { kind: "key_manager_connection", connectionId } }) as const;

  const conflict = (reason: string, message: string, data: Record<string, string>) => ({ code: "conflict", message, data: { reason, ...data } }) as const;

  /** Another connection of `provider` at `address`, refused `connection_exists`; null for none. */
  const addressTaken = (provider: KeyManagerProvider, address: string, except?: string) => {
    const holder = addressHolder(reader, provider, address);
    return holder === null || holder === except
      ? null
      : conflict("connection_exists", `${PROVIDER_NAMES[provider]} at ${address} is connected on this environment already.`, { provider, address, connectionId: holder });
  };

  /** Why an add cannot go ahead as the store is now: an id used before, or the provider and address held; null when it can. */
  const addRefusal = (connectionId: string, provider: KeyManagerProvider, address: string): Refusal<"keyManagers.connections.add"> | null => {
    if (connectionEver(reader, connectionId)) return conflict("exists", `A key-manager connection ${connectionId} was added already.`, { connectionId });
    return addressTaken(provider, address);
  };

  /** A sign-in the key manager refused, in setup-copy.md §5.7's words, what it said and that nothing was kept in details (#1852). */
  const verificationFailed = (connectionId: string, provider: KeyManagerProvider, refused: Pick<Extract<SignInResult, { outcome: "refused" }>, "reason" | "message">, nothing: string) =>
    ({ code: "verification_failed", message: refusedLine(provider, refused.reason), data: { connectionId, reason: refused.reason, details: [oneLine(refused.message), nothing] } }) as const;

  /** The refusal of a sign-in that could not ask the key manager at `address`, in §5.7's words, what was met and that nothing changed in details. */
  const couldNotAsk = (connectionId: string, provider: KeyManagerProvider, address: string, result: Extract<SignInResult, { outcome: keyof typeof FAILURE_CODES }>) => {
    const details = [oneLine(result.message), "Nothing was changed."];
    if (result.outcome === "provider-unavailable") return { code: "provider_unavailable", message: providerUnavailableLine(provider), data: { connectionId, provider, details } } as const;
    return { code: FAILURE_CODES[result.outcome], message: couldNotAskLine(provider, address, result.outcome), data: { connectionId, details } } as const;
  };

  /** This environment has no provider for the key manager: it says it cannot connect yet, never what to do instead (#1852). */
  const providerUnavailable = (provider: KeyManagerProvider) =>
    ({ code: "provider_unavailable", message: providerUnavailableLine(provider), data: { provider, details: [`No ${PROVIDER_NAMES[provider]} provider is loaded on this environment.`, "Nothing was stored."] } }) as const;

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

  /** OpenBao's settings of an add: its CA, method, mount, username and token role; all null for another provider, which takes none and signs in with a token. */
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

  /**
   * Where a connection signs in, at `address` with `ca`: OpenBao by its
   * method at its mount, null while it has none; another provider with its
   * token (Doppler's, #377; 1Password's service-account token, #378;
   * Bitwarden's access token, #379), trusting no pinned CA.
   */
  const targetOf = (record: Pick<KeyManagerConnectionRecord, "provider" | "address" | "ca" | "method" | "mount" | "username">, address = record.address, ca = record.ca): SignInTarget | null => {
    if (record.provider !== "openbao") return { address, ca: null, method: "token", mount: "token", username: null };
    return record.method === null || record.mount === null ? null : { address, ca, method: record.method, mount: record.mount, username: record.username };
  };

  /**
   * The address a credential names for itself, for a provider whose
   * connection's address is learned at sign-in (1Password's account URL,
   * #378): refused as the key manager would refuse it when it names none,
   * and as another account's when it is not `expected`. Undefined for a
   * provider whose address is given, or no credential.
   */
  const namedAddress = (
    connectionId: string,
    provider: ConnectionProvider | undefined,
    kind: KeyManagerProvider,
    credential: KeyManagerCredential | undefined,
    expected: string | null,
    nothing: string,
  ): string | { readonly refused: CommandRejection<"verification_failed"> } | undefined => {
    if (provider?.addressOf === undefined || credential === undefined) return undefined;
    const named = provider.addressOf(credential);
    const refuse = (message: string) => ({ refused: verificationFailed(connectionId, kind, { reason: "rejected", message }, nothing) });
    if (named === null) return refuse(`That is no ${PROVIDER_NAMES[kind]} credential that names its account.`);
    if (expected !== null && named !== expected) return refuse(`That token is for the ${PROVIDER_NAMES[kind]} account at ${named}, and this connection is for ${expected}: add a connection for that account.`);
    return named;
  };

  /** The fields a first sign-in sets beside its outcome: OpenBao's ticks preset to the login's policies (another provider's login holds none), and whether it now injects. */
  const firstSignIn = (record: KeyManagerConnectionRecord, information: KeyManagerTokenInformation): Pick<KeyManagerConnectionSignedInPayload, "ticks" | "injects"> => ({
    ...(record.provider === "openbao" && record.ticks === null && { ticks: information.policies }),
    ...(!record.injects && !injecting(reader, record.provider) && { injects: true as const }),
  });

  const add: KeyManagerConnections["add"] = {
    async prepare(params, context) {
      const connectionId = params.connectionId.toLowerCase();
      const given = params.credential;
      // Registered as it arrives, before anything can answer with it; let go unless the add is accepted.
      const arrival = given === undefined ? null : registerCredential(connectionId, given);
      if (arrival !== null) context.onUndo(arrival);
      const provider = providers[params.provider];
      // Only for a provider this environment signs in to: another's credential is provider_unavailable below, whatever its method.
      if (params.provider !== "openbao" && provider !== undefined && given !== undefined && given.method !== "token") {
        invalid(["credential", "method"], `${PROVIDER_NAMES[params.provider]} signs in with ${params.provider === "bitwarden" ? "an access token" : "a token"}.`);
      }
      const typed =
        params.address === undefined ? null : (httpOriginOf(params.address) ?? invalid(["address"], "The address is no https or http URL of a key manager: give its origin, as https://bao.example.com:8200."));
      const named = namedAddress(connectionId, provider, params.provider, given, null, "Nothing was stored.");
      if (named !== undefined && typeof named !== "string") return rejecting<"keyManagers.connections.add">(named.refused);
      if (named !== undefined && typed !== null && typed !== named) invalid(["address"], `The token is for the ${PROVIDER_NAMES[params.provider]} account at ${named}, not ${typed}.`);
      const address =
        named ??
        typed ??
        invalid(
          ["address"],
          params.provider === "onepassword" ? "A 1Password connection added without a token names its account URL, as https://my.1password.com." : "Give the key manager's address.",
        );
      if (params.importedFrom !== undefined && params.copiedFrom !== undefined) invalid(["importedFrom"], "A connection is copied or imported, not both.");
      if (params.importedFrom !== undefined && given !== undefined) invalid(["credential"], "An imported connection signs in on this environment: the import sends no credential.");
      const settings = settingsOf(params, address);
      const basePathRefused = params.basePath === undefined ? null : basePathProblem(params.provider, params.basePath);
      if (basePathRefused !== null) invalid(["basePath"], basePathRefused);
      if (given !== undefined && provider === undefined) return rejecting<"keyManagers.connections.add">(providerUnavailable(params.provider));
      /** The connection the state import made from the same source id, which a repeated import is answered with. */
      const imported = () => (params.importedFrom === undefined ? null : importedHolder(reader, params.importedFrom));
      const doomed = imported() === null ? addRefusal(connectionId, params.provider, address) : null;
      if (doomed !== null) return rejecting<"keyManagers.connections.add">(doomed);

      let status = awaitingSignIn();
      let signed: Extract<SignInResult, { outcome: "signed-in" }> | null = null;
      let entry: string | null = null;
      const target = targetOf({ provider: params.provider, address, ...settings });
      if (given !== undefined && provider !== undefined && target !== null) {
        const result = await signInWith(connectionId, provider, target, given);
        if (result.outcome === "refused") return rejecting<"keyManagers.connections.add">(verificationFailed(connectionId, params.provider, result, "Nothing was stored."));
        if (result.outcome === "signed-in") {
          context.onUndo(() => letGo(connectionId, result.login));
          signed = result;
          status = signedInStatus(params.provider, result.information);
        } else {
          status = statusNow(STATUS_OF[result.outcome], result.message);
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
          ticks: params.ticks ?? (params.provider === "openbao" ? signed?.information.policies : undefined) ?? null,
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
          if (signed !== null) logins.hold(connectionId, signed.login);
          if (entry !== null) schedule.changed(connectionId);
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
      const provider = providers[record.provider];
      if (provider === undefined) return rejecting<"keyManagers.connections.signIn">(providerUnavailable(record.provider));
      if (record.provider !== "openbao") {
        if (given.method !== "token") invalid(["credential", "method"], `${PROVIDER_NAMES[record.provider]} signs in with a token.`);
        for (const field of ["mount", "username"] as const) if (params[field] !== undefined) invalid([field], `${field} is OpenBao's: a ${PROVIDER_NAMES[record.provider]} connection takes none.`);
      }
      const named = namedAddress(connectionId, provider, record.provider, given, record.address, "Nothing was changed.");
      if (named !== undefined && typeof named !== "string") return rejecting<"keyManagers.connections.signIn">(named.refused);
      const method = given.method;
      const mount = mountFor(method, params.mount ?? (method === record.method ? (record.mount ?? undefined) : undefined));
      const username = usernameFor(method, params.username, record.username);
      const target = targetOf({ ...record, method, mount, username });
      if (target === null) throw new Error(`The key-manager connection ${connectionId} has no sign-in target for ${method}.`);

      const result = await signInWith(connectionId, provider, target, given);
      if (result.outcome === "refused") return rejecting<"keyManagers.connections.signIn">(verificationFailed(connectionId, record.provider, result, "Nothing was changed."));
      if (result.outcome !== "signed-in") return rejecting<"keyManagers.connections.signIn">(couldNotAsk(connectionId, record.provider, target.address, result));
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
          // Only OpenBao's record keeps how it signs in; the others sign in with a token alone.
          ...(now.provider === "openbao" && method !== now.method && { method }),
          ...(now.provider === "openbao" && mount !== now.mount && { mount }),
          ...(now.provider === "openbao" && username !== now.username && { username }),
          ...firstSignIn(now, result.information),
        };
        log.append(stream, [{ type: "key-manager.connection.signed-in", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => {
          moved(connectionId);
          holdCredential(connectionId, arrival);
          logins.hold(connectionId, result.login);
          if (current.credential !== null) deleteEntry(current.credential);
          schedule.changed(connectionId);
        });
        return { aggregate: stream, result: { connection: settledRecordOf(connectionId) } };
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
      if (record.provider === "onepassword" && params.address !== undefined) {
        invalid(["address"], "A 1Password connection's address is its account's URL, which its token names: sign in with another account's token on a connection of its own.");
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
            if (signed !== null) command.tx.afterCommit(() => background.run(letGo(connectionId, signed.login)));
            return { aggregate: stream, result: { connection: standing(now) } };
          }
          const at = { tx: command.tx, actor: command.actor, commandId: command.commandId };
          log.append(stream, [{ type: "key-manager.connection.updated", payload: { connectionId, ...changes } }], at);
          command.tx.afterCommit(() => schedule.changed(connectionId));
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
              logins.hold(connectionId, signed.login);
            });
            return { aggregate: stream, result: { connection: settledRecordOf(connectionId) } };
          }
          return { aggregate: stream, result: { connection: recordOf(connectionId) } };
        };

      // A new address or CA is signed in against first, with the credential held; a connection holding none changes at once.
      const target = targetOf(record, address, ca);
      const provider = providers[record.provider];
      const entry = held.credential;
      if ((address === record.address && ca === record.ca) || entry === null || target === null || provider === undefined) return apply(null);
      return (async () => {
        const credential = await readCredential(entry);
        if (credential === null) return apply(null);
        const result = await signInWith(connectionId, provider, target, credential);
        if (result.outcome === "refused") return rejecting<"keyManagers.connections.update">(verificationFailed(connectionId, record.provider, result, "Nothing was changed."));
        if (result.outcome !== "signed-in") return rejecting<"keyManagers.connections.update">(couldNotAsk(connectionId, record.provider, target.address, result));
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
                ? refusedStatus(current.record, result.message)
                : statusNow(STATUS_OF[result.outcome], result.message);
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
      if (recorded) logins.hold(connectionId, signed.login);
      else await letGo(connectionId, signed.login);
    } catch (error) {
      console.error(`Signing the key-manager connection ${connectionId} in from its kept credential failed:`, error);
    } finally {
      if (signingIn.get(connectionId) === since) signingIn.delete(connectionId);
    }
  };

  /**
   * What a verification of the connection verifies now: its credential, the
   * commands that changed its login or address since, its token role, and
   * the login held and whether it is due (#369), so a verification asked for
   * a login due waits for one running for it before and asks again; null for
   * one that is not verified (no credential, or a provider this version
   * cannot sign in to).
   */
  const subjectOf = (connectionId: string): string | null => {
    const held = liveConnection(reader, connectionId);
    if (held === null || held.credential === null || providers[held.record.provider] === undefined || targetOf(held.record) === null) return null;
    return JSON.stringify([held.credential, epochOf(connectionId), held.record.tokenRole, logins.generation(connectionId), logins.isDue(connectionId)]);
  };

  /**
   * Stops holding a login the key manager no longer knows, while it is still
   * the one held: there is nothing left to revoke. Its token stays registered
   * until the verification that found it dead ends (`dead`), so the text of
   * an answer that echoes it is scrubbed still.
   */
  const dropDead = (connectionId: string, login: Login, dead: Login[]): void => {
    if (logins.drop(connectionId, login)) dead.push(login);
  };

  const failedWith = (status: KeyManagerStatus): Checked => ({ outcome: "failed", status });

  /**
   * What the key manager answers of the connection now: asked with the login
   * held; with none held, a login the environment made that is due, or one
   * the key manager no longer knows, after signing in from the kept
   * credential.
   */
  const ask = async (record: KeyManagerConnectionRecord, entry: string, provider: ConnectionProvider, target: SignInTarget, signal: AbortSignal, dead: Login[]): Promise<Checked> => {
    const connectionId = record.id;
    const verifyWith = async (login: Login, fresh: boolean): Promise<Checked> => {
      const answer = await provider.verify(target, login.token, { tokenRole: record.tokenRole, signal });
      if (answer.outcome === "verified") return { outcome: "verified", answer, login, fresh };
      if (fresh) await letGo(connectionId, login);
      if (answer.outcome !== "credential-rejected") return failedWith(statusNow(STATUS_OF[answer.outcome], scrubbed(answer.message)));
      if (!fresh) {
        dropDead(connectionId, login, dead);
        // A login the environment made has lived out its life, or was revoked: it signs in again from the kept credential.
        if (login.minted) return signInAgain();
      }
      return failedWith(refusedStatus(record, scrubbed(answer.message)));
    };
    const signInAgain = async (): Promise<Checked> => {
      const credential = await readCredential(entry);
      if (credential === null) return failedWith(refusedStatus(record, "The environment's vault holds no credential for this connection."));
      const result = await signInWith(connectionId, provider, target, credential, signal);
      if (result.outcome === "signed-in") return verifyWith(result.login, true);
      if (result.outcome === "refused") return failedWith(refusedStatus(record, result.message));
      return failedWith(statusNow(STATUS_OF[result.outcome], result.message));
    };
    const held = logins.current(connectionId);
    return held === undefined || logins.isDue(connectionId) ? signInAgain() : verifyWith(held, false);
  };

  /** Settles as `work` does, or as unreachable once the budget has passed, when the work's signal is aborted too; a login the work made after that is let go. */
  const withinBudget = async (record: KeyManagerConnectionRecord, work: (signal: AbortSignal) => Promise<Checked>): Promise<Checked> => {
    const controller = new AbortController();
    const overrun = new Promise<Checked>((resolve) => {
      controller.signal.addEventListener("abort", () =>
        resolve(failedWith(statusNow("unreachable", `${PROVIDER_NAMES[record.provider]} at ${record.address} did not finish answering within ${budgetMs / 1000} s.`))),
      );
    });
    const working = work(controller.signal).then(
      (checked) => {
        if (controller.signal.aborted && checked.outcome === "verified" && checked.fresh) background.run(letGo(record.id, checked.login));
        return checked;
      },
      (error: unknown) => {
        console.error(`Verifying the key-manager connection ${record.id} failed:`, error);
        return failedWith(statusNow("unreachable", `Verifying ${PROVIDER_NAMES[record.provider]} at ${record.address} failed inside the environment; it is tried again in fifteen minutes.`));
      },
    );
    // Past the budget the verification ends, and its work goes on until its signal stops it.
    background.run(working);
    // On the wall clock, never the environment's, which a test may hold still.
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref();
    try {
      return await Promise.race([working, overrun]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Records what a verification found of the connection, unless a command
   * changed what it verifies meanwhile; answers whether it was taken. A
   * verification that signed in records that first, as the environment's own
   * sign-in; then `key-manager.connection.verified` when the status, token
   * information, policies or `canMint` changed, a status of the kind there
   * was keeping its since-time.
   */
  const recordFound = (connectionId: string, subject: string, checked: Checked): boolean =>
    log.atomically((tx) => {
      const current = subjectOf(connectionId) === subject ? liveConnection(reader, connectionId) : null;
      if (current === null) return false;
      const at = { tx, actor: KEY_MANAGER_ACTOR };
      let before = current.record;
      let found: Omit<KeyManagerConnectionVerifiedPayload, "connectionId">;
      if (checked.outcome === "failed") {
        found = { status: checked.status, tokenInformation: before.tokenInformation, policies: before.policies, canMint: before.canMint };
      } else {
        const { information, policies, canMint } = checked.answer;
        const status = signedInStatus(before.provider, information);
        if (checked.fresh) {
          const payload: KeyManagerConnectionSignedInPayload = { connectionId, status, tokenInformation: information, ...firstSignIn(before, information) };
          log.append(stream, [{ type: "key-manager.connection.signed-in", payload }], at);
          before = settledRecordOf(connectionId);
        }
        found = { status, tokenInformation: information, policies: [...policies], canMint };
      }
      const changed =
        before.status.kind !== found.status.kind ||
        !sameInformation(before.tokenInformation, found.tokenInformation) ||
        JSON.stringify(before.policies) !== JSON.stringify(found.policies) ||
        before.canMint !== found.canMint;
      if (changed) {
        const status = before.status.kind === found.status.kind ? { ...found.status, since: before.status.since } : found.status;
        log.append(stream, [{ type: "key-manager.connection.verified", payload: { connectionId, ...found, status } }], at);
      }
      return true;
    });

  /** One verification of the connection, within the budget, recording what it found; it never rejects. */
  const verifyNow = async (connectionId: string): Promise<void> => {
    try {
      // What the startup's sign-in records is what this verification starts from.
      await startupSignIns.get(connectionId);
      if (closed) return;
      const subject = subjectOf(connectionId);
      const held = liveConnection(reader, connectionId);
      const provider = held === null ? undefined : providers[held.record.provider];
      const target = held === null ? null : targetOf(held.record);
      if (subject === null || held === null || held.credential === null || provider === undefined || target === null) return;
      const entry = held.credential;
      const checked = await withinBudget(held.record, async (signal) => {
        const dead: Login[] = [];
        try {
          return await ask(held.record, entry, provider, target, signal, dead);
        } finally {
          // Once the work ends, past the budget or not: every line it made is scrubbed by then.
          for (const login of dead) login.release();
        }
      });
      const verifiedAt = clock.now().toISOString();
      let taken = false;
      try {
        // Asked before anything is recorded, so the verification is seen whole: a client reading the records on its event reads the suggestion too (#689). On the wall clock, never the environment's, which a test may hold still.
        const suggested =
          !closed && checked.outcome === "verified" && held.record.basePath === null
            ? await providerSuggestion(held.record.provider, provider, target, checked.login.token, AbortSignal.timeout(budgetMs))
            : undefined;
        // Closed, the event log may be too: nothing is read or recorded, and a login made is let go.
        taken = !closed && recordFound(connectionId, subject, checked);
        if (taken) verifiedTimes.set(connectionId, verifiedAt);
        if (taken && suggested !== undefined) suggestions.set(connectionId, suggested);
      } finally {
        // A login the verification made is held once what it found is recorded; otherwise, a failed write included, it is let go.
        if (checked.outcome === "verified" && checked.fresh) {
          if (taken) logins.hold(connectionId, checked.login);
          else background.run(letGo(connectionId, checked.login));
        }
      }
    } catch (error) {
      console.error(`Verifying the key-manager connection ${connectionId} failed:`, error);
    }
  };

  const schedule = createVerificationSchedule({
    clock,
    connectionIds: () => listConnections(reader).map((held) => held.record.id),
    subjectOf,
    verifyNow,
    background,
  });

  const readable = (connectionId: string): ReadableConnection | null => {
    const held = liveConnection(reader, connectionId.toLowerCase());
    if (held === null) return null;
    const login = logins.current(held.record.id);
    return { record: standing(held.record), login: login === undefined ? null : { token: login.token, provider: login.provider, target: login.target } };
  };

  const runTokens = createRunTokens({
    source: {
      injecting: () =>
        listConnections(reader).flatMap((held) =>
          held.record.injects ? [{ record: standing(held.record), generation: held.generation, loginGeneration: logins.generation(held.record.id) }] : [],
        ),
      readable: (connectionId) => {
        const held = liveConnection(reader, connectionId);
        return held === null ? null : { record: standing(held.record), login: logins.minting(held.record.id) };
      },
      signingIn: (connectionId) => startupSignIns.get(connectionId),
    },
    clock,
    scrub,
    cliDirectory: options.cliDirectory,
    budgetMs,
    background,
  });

  const canImport: KeyManagerConnections["canImport"] = (params) => {
    const address = httpOriginOf(params.address ?? "");
    if (address === null) return false;
    const settings = settingsOf({ ...params, credential: undefined }, address);
    const held = liveConnection(reader, params.connectionId.toLowerCase());
    if (held === null) return addRefusal(params.connectionId.toLowerCase(), params.provider, address) === null;
    return held.record.provider === params.provider && held.record.address === address &&
      (Object.keys(settings) as (keyof typeof settings)[]).every((key) => held.record[key] === settings[key]);
  };

  return {
    canImport,
    importRecord(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      if (!canImport(params)) return { aggregate: stream, rejected: conflict("exists", "Its connection id or address is occupied by incompatible settings; no reference was retargeted.", { connectionId }) };
      if (liveConnection(reader, connectionId) !== null) return { aggregate: stream, result: { targetId: connectionId, carried: false } };
      const address = httpOriginOf(params.address ?? "");
      if (address === null) return { aggregate: stream, rejected: conflict("exists", "The connection has no valid address.", { connectionId }) };
      const payload: KeyManagerConnectionAddedPayload = {
        connectionId, provider: params.provider, label: params.label, address,
        ...settingsOf({ ...params, credential: undefined }, address),
        ticks: null, basePath: null, injects: false, status: awaitingSignIn(), tokenInformation: null,
        credential: null, copiedFrom: null, importedFrom: params.importedFrom ?? null,
      };
      log.append(stream, [{ type: "key-manager.connection.added", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { targetId: connectionId, carried: true } };
    },
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

    startSigningInAndVerifying() {
      for (const { record, credential } of listConnections(reader)) {
        const provider = providers[record.provider];
        const target = targetOf(record);
        if (credential === null || provider === undefined || target === null) continue;
        const running = signInFromVault(record, credential, provider, target).finally(() => {
          if (startupSignIns.get(record.id) === running) startupSignIns.delete(record.id);
        });
        startupSignIns.set(record.id, running);
        background.run(running);
      }
      schedule.start();
    },

    list: () => listConnections(reader).map((held: StoredConnection) => standing(held.record)),

    async verify(connectionId) {
      const id = connectionId?.toLowerCase();
      if (id !== undefined && liveConnection(reader, id) === null) throw new ContractError(notFound(id));
      await Promise.all((id === undefined ? listConnections(reader).map((held) => held.record.id) : [id]).map(schedule.verify));
      return listConnections(reader).map((held) => standing(held.record));
    },

    add,

    signIn,

    update,

    setPolicies(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      const { record } = held;
      const policies = record.tokenInformation?.policies ?? invalid(["ticks"], "The connection has no login whose policies could be ticked: sign it in first.");
      const foreign = params.ticks.findIndex((tick) => !policies.includes(tick));
      if (foreign !== -1) invalid(["ticks", foreign], `${params.ticks[foreign]} is not one of the login's policies (${policies.join(", ")}).`);
      // Kept in the order the login's lookup names them, each once.
      const ticks = policies.filter((policy) => params.ticks.includes(policy));
      if (JSON.stringify(ticks) === JSON.stringify(record.ticks)) return { aggregate: stream, result: { connection: standing(record) } };
      log.append(stream, [{ type: "key-manager.connection.policies-set", payload: { connectionId, ticks } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { connection: recordOf(connectionId) } };
    },

    setBasePath(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      const { record } = held;
      const problem = basePathProblem(record.provider, params.basePath);
      if (problem !== null) invalid(["basePath"], problem);
      if (params.basePath === record.basePath) return { aggregate: stream, result: { connection: standing(record) } };
      const payload = { connectionId, basePath: params.basePath };
      log.append(stream, [{ type: "key-manager.connection.base-path-set", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { connection: recordOf(connectionId) } };
    },

    setInjected(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      const { record } = held;
      if (record.injects) return { aggregate: stream, result: { connection: standing(record) } };
      const replaced = listConnections(reader).find((each) => each.record.provider === record.provider && each.record.injects)?.record.id ?? null;
      log.append(stream, [{ type: "key-manager.connection.injected-set", payload: { connectionId, replaced } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { connection: recordOf(connectionId) } };
    },

    signOut(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      if (held.credential === null) return { aggregate: stream, result: { connection: standing(held.record) } };
      const status = statusNow("awaiting-sign-in", "Signed out: sign in again in Set up, Key manager.");
      log.append(stream, [{ type: "key-manager.connection.signed-out", payload: { connectionId, status } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      command.tx.afterCommit(() => {
        forget(connectionId, held.credential);
        schedule.removed(connectionId);
      });
      return { aggregate: stream, result: { connection: settledRecordOf(connectionId) } };
    },

    remove(params, command) {
      const connectionId = params.connectionId.toLowerCase();
      const held = liveConnection(reader, connectionId);
      if (held === null) return { aggregate: stream, rejected: notFound(connectionId) };
      const holders = params.force === true ? [] : (options.referenceHolders?.(connectionId) ?? []);
      if (holders.length > 0) {
        const named = holders.map((holder) => `the credential of the ${HOLDER_KINDS[holder.kind]} ${holder.name}`).join(", ");
        return {
          aggregate: stream,
          rejected: {
            code: "conflict",
            message: `The key-manager connection ${held.record.label} is named by ${named}: give it another credential first, or remove the connection with force.`,
            data: { reason: "referenced", connectionId, holders: [...holders] },
          },
        };
      }
      log.append(stream, [{ type: "key-manager.connection.removed", payload: { connectionId } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      command.tx.afterCommit(() => {
        forget(connectionId, held.credential);
        schedule.removed(connectionId);
        verifiedTimes.delete(connectionId);
      });
      return { aggregate: stream, result: { connectionId } };
    },

    readable,

    processEnvironment: runTokens.supplier,

    settled: () => background.settled(),

    close() {
      closed = true;
      schedule.close();
      // The logins first: a run token let go on the close must not revoke a login it was the last of.
      logins.close();
      runTokens.close();
      for (const release of credentials.values()) release();
      credentials.clear();
    },
  };
};

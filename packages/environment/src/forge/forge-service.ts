import { randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  GITHUB_ORIGIN,
  deriveForgeSlug,
  forgeGitUsername,
  invalidParams,
  normaliseRemote,
  type ErrorOf,
  type ForgeAccountAddedPayload,
  type ForgeAccountRecord,
  type ForgeAccountUpdatedPayload,
  type ForgeAddCredential,
  type ForgeCredentialSource,
  type ForgeIdentity,
  type ForgeKind,
  type ForgeOrigin,
  type ForgeProblem,
  type GhProbe,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import { noKeyManagerConnections, type KeyManagerRegistry } from "../key-managers/registry.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PrepareContext, PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { forgeAccountEver, listForgeAccounts, liveForgeAccount, originHolder, primaryForgeAccount, slugHolder } from "./forge-store.js";
import { managedGh, type ManagedGh } from "./gh.js";
import { FORGE_CALL_TIMEOUT_MS, forgeProvider, type ForgeFetch, type IdentityAnswer } from "./providers.js";

/**
 * The ForgeService's forge account store (forge spec, "The forge account
 * record", "Credentials" and "Wire methods"; ADR 0012, ADR 0020): the rules
 * over the store's read model, and the tokens it holds in the vault.
 *
 * - **A pasted token crosses the wire once.** It is registered with the
 *   scrub registry as it arrives, with its Basic-auth form once the login
 *   that names it is known, so no event, receipt, log line or answer can
 *   carry it; it is written to the vault before the command's transaction,
 *   under an entry of its own, and the entry is deleted again, and the
 *   registration let go, when the command is not accepted. A token held
 *   stays registered while the vault holds it, from start.
 * - **The identity call comes first.** Add and update are prepared
 *   commands: their prepare asks the forge's identity endpoint who the token
 *   is, outside the transaction. A refusal stores nothing
 *   (`verification_failed`); a forge that does not answer keeps the forge
 *   account with problem `unreachable`.
 * - **A replaced or removed token's entry** is deleted once its command has
 *   committed; a start deletes every forge entry no forge account holds,
 *   whatever an interrupted deletion left.
 * - **One primary**: the first forge account becomes primary; setting
 *   another clears it in the same event; removing the primary leaves none.
 * - **A credential is read per operation** (`resolveCredential`, and the
 *   identity call of an add or update): a stored token from the vault; the
 *   environment's `gh` through `gh auth token` for the host and the source's
 *   login, so a rotation in `gh` is followed; a reference through the
 *   key-manager registry's resolve seam, so a rotation in the key manager is
 *   live at once. A token `gh` or a key manager gives is registered with the
 *   scrub registry for its operation and released when it ends, never
 *   cached, so a read that fails never falls back to an earlier value. A
 *   copy with no credential (`none`) is never read and never verified: it
 *   has problem `needs-credential` until one is given.
 */

/** What every vault entry holding a forge token is named with. */
const VAULT_PREFIX = "forge:";

/** A new vault entry for a token given to `forgeAccountId`: one per credential, so a replacement never overwrites the token it replaces. */
const newEntry = (forgeAccountId: string): string => `${VAULT_PREFIX}${forgeAccountId}:${randomUUID()}`;

/** The form of `token` a Basic `Authorization` header carries for git's `username`. */
const basicAuthForm = (username: string, token: string): string => Buffer.from(`${username}:${token}`).toString("base64");

export interface ForgeServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's id: the id of its stream, where the forge's events go. */
  readonly environmentId: string;
  /** The vault as the environment holds it: every entry registered with the scrub registry while it is held. */
  readonly vault: Vault;
  readonly scrub: ScrubRegistry;
  /** How the providers reach a forge; preset: the global `fetch`. */
  readonly fetch?: ForgeFetch;
  /** How long one call to a forge may take; preset `FORGE_CALL_TIMEOUT_MS`. */
  readonly callTimeoutMs?: number;
  /** The environment's own `gh`, behind the Managed tools seam #91's registry replaces; preset: the `gh` on this process's PATH. */
  readonly gh?: ManagedGh;
  /** The key-manager registry's resolve seam, which #91 fills; preset: no key-manager connection, so every reference is unavailable. */
  readonly keyManagers?: KeyManagerRegistry;
  /** A client session's label, which a token its client's `gh` handed over records beside its id. */
  readonly clientSessionLabel: (clientSessionId: string) => string | undefined;
}

type Refusal<N extends MethodName> = CommandRejection<ErrorOf<N>["code"]>;

/** A token the state import carried over (ADR 0036), which it adds in process: no client may send one. */
export interface ImportedCredential {
  readonly kind: "stored";
  readonly provenance: "imported";
  readonly token: string;
}

/** What `forge.accounts.add` is given: a client's params, or the state import's in process with a credential it carried over. */
export type ForgeAddRequest = Omit<ParamsOf<"forge.accounts.add">, "credential"> & { readonly credential: ForgeAddCredential | ImportedCredential };

/**
 * `forge.accounts.add` as the ForgeService prepares it. The wire's schema
 * lets no client send an imported token; the state import calls `prepare`
 * in process with one and applies the handler it answers inside its own
 * transaction.
 */
export interface ForgeAdd {
  readonly prepare: (params: ForgeAddRequest, context: PrepareContext) => Promise<ForgeAddHandler>;
}

/** The handler an add's prepare answers, applied inside the command's transaction; it reads nothing of the params it is given. */
export type ForgeAddHandler = (params: ForgeAddRequest, context: CommandContext) => CommandAnswer<ResultOf<"forge.accounts.add">, ErrorOf<"forge.accounts.add">["code"]>;

/** A forge account's credential for one operation. */
export type ForgeCredential =
  /** The token, and the release that ends its registration for scrubbing: call it when the operation ends. */
  | { readonly outcome: "resolved"; readonly token: string; readonly release: ScrubRelease }
  /** No token: `needs-credential` for a copy awaiting one, `credential-unavailable` for `gh`, a key manager or the vault giving none. */
  | { readonly outcome: "unavailable"; readonly problem: ForgeProblem };

export interface ForgeService {
  /** Registers every stored token the vault holds with its forms, and deletes the forge entries no forge account holds; startup runs it once, before the wire opens. */
  start(): Promise<void>;
  /** The forge accounts, in the order they were added. */
  list(): ForgeAccountRecord[];
  /**
   * Reads the forge account's credential for one operation, `purpose` in a
   * few words: every harness operation on a forge reads it again, and calls
   * the release when it ends. Null when the environment does not hold the
   * forge account.
   */
  resolveCredential(forgeAccountId: string, purpose: string): Promise<ForgeCredential | null>;
  /** What the environment's own `gh` is: installed, its version against the minimum, and who it is signed in as. */
  probeGh(): Promise<GhProbe>;
  readonly add: ForgeAdd;
  readonly update: PreparedCommand<"forge.accounts.update">;
  readonly remove: MethodHandler<"forge.accounts.remove">;
  readonly setPrimary: MethodHandler<"forge.accounts.setPrimary">;
  /** Lets go of every token's registration. */
  close(): void;
}

export const createForgeService = (options: ForgeServiceOptions): ForgeService => {
  const { log, clock, vault, scrub, clientSessionLabel } = options;
  const gh = options.gh ?? managedGh();
  const keyManagers = options.keyManagers ?? noKeyManagerConnections;
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  const providerOptions = { fetch: options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)), timeoutMs: options.callTimeoutMs ?? FORGE_CALL_TIMEOUT_MS };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The scrub registration of each stored token the environment holds, by forge account. */
  const held = new Map<string, ScrubRelease>();

  /**
   * Registers `token` for its forge account with the form git's Basic
   * header carries it in: under `x-access-token` for GitHub, under the
   * login for Forgejo and Gitea once it is known.
   */
  const register = (forgeAccountId: string, token: string, kind: ForgeKind, login: string | null): ScrubRelease => {
    const username = forgeGitUsername(kind, login ?? "");
    return scrub.register(token, { owner: `forge:${forgeAccountId}`, forms: username === "" ? [] : [basicAuthForm(username, token)] });
  };

  /** Holds `release` as the forge account's registration, letting go of the one it replaces; null holds none. */
  const hold = (forgeAccountId: string, release: ScrubRelease | null): void => {
    held.get(forgeAccountId)?.();
    if (release === null) held.delete(forgeAccountId);
    else held.set(forgeAccountId, release);
  };

  /** Deletes a vault entry a committed command let go of; one left behind is deleted by the next start. */
  const deleteEntry = (entry: string): void => {
    vault.delete(entry).catch((error: unknown) => console.error(`Deleting the vault entry ${entry} failed; the next start deletes it:`, error));
  };

  const identify = (kind: ForgeKind, origin: ForgeOrigin, token: string): Promise<IdentityAnswer> => forgeProvider(kind, providerOptions).identity(origin, token);

  /** A problem of `kind` since now. */
  const problemNow = (kind: ForgeProblem["kind"], message: string): ForgeProblem => ({ kind, since: clock.now().toISOString(), message });

  /** The problem a forge that did not answer leaves, since now. */
  const unreachable = (message: string): ForgeProblem => problemNow("unreachable", message);

  const needsCredential = (): ForgeProblem => problemNow("needs-credential", "This forge account has no credential on this environment: give it one in Set up, Forges.");

  /** The host `gh` names an origin's instance by: github.com, or an Enterprise host with its port. */
  const ghHost = (origin: ForgeOrigin): string => origin.replace(/^https?:\/\//, "");

  /** What a credential is read for: a forge account, as held or as an add or update is about to give it. */
  interface CredentialTarget {
    readonly id: string;
    readonly origin: ForgeOrigin;
    readonly kind: ForgeKind;
    /** The login the forge knows the account by, for the Basic-auth form of a token; null until the forge has answered. */
    readonly login: string | null;
    readonly credential: ForgeCredentialSource;
  }

  /**
   * Reads `target`'s credential now, for one operation. A stored token is
   * registered while the vault holds it; one `gh` or a key manager gives is
   * registered here, released by the answer's release.
   */
  const readCredential = async (target: CredentialTarget, purpose: string): Promise<ForgeCredential> => {
    const { id, credential } = target;
    switch (credential.kind) {
      case "none":
        return { outcome: "unavailable", problem: needsCredential() };
      case "stored": {
        let token: string | undefined;
        try {
          token = await vault.get(credential.entry);
        } catch (error) {
          console.error(`Reading the vault entry ${credential.entry} failed:`, error);
        }
        if (token === undefined) {
          return { outcome: "unavailable", problem: problemNow("credential-unavailable", "The environment's vault holds no token for this forge account: give it a credential again in Set up, Forges.") };
        }
        return { outcome: "resolved", token, release: () => undefined };
      }
      case "gh": {
        const answer = await gh.token(ghHost(target.origin), credential.login);
        if (answer.outcome === "unavailable") return { outcome: "unavailable", problem: problemNow("credential-unavailable", answer.message) };
        return { outcome: "resolved", token: answer.token, release: register(id, answer.token, target.kind, target.login) };
      }
      case "reference": {
        const answer = await keyManagers.resolve({ reference: credential.reference, owner: `forge:${id}`, purpose });
        if (answer.outcome === "unavailable") return { outcome: "unavailable", problem: problemNow("credential-unavailable", answer.message) };
        const own = register(id, answer.value, target.kind, target.login);
        return {
          outcome: "resolved",
          token: answer.value,
          release: () => {
            own();
            answer.release();
          },
        };
      }
    }
  };

  const recordOf = (forgeAccountId: string): ForgeAccountRecord => {
    const record = liveForgeAccount(reader, forgeAccountId);
    if (record === null) throw new Error(`The forge account ${forgeAccountId} is not in the store after a command applied to it.`);
    return record;
  };

  const notFound = (forgeAccountId: string) =>
    ({ code: "not_found", message: `No forge account ${forgeAccountId} is on this environment.`, data: { kind: "forge_account", forgeAccountId } }) as const;

  const conflict = (reason: string, message: string, data: Record<string, string>) => ({ code: "conflict", message, data: { reason, ...data } }) as const;

  const slugTaken = (slug: string, except?: string) => {
    const holder = slugHolder(reader, slug);
    return holder === null || holder === except ? null : conflict("slug_taken", `The slug ${slug} is taken by another forge account on this environment.`, { slug, forgeAccountId: holder });
  };

  /** Why an add cannot go ahead as the store is now: an id used before, an origin held, a slug taken; null when it can. */
  const addRefusal = (forgeAccountId: string, origin: ForgeOrigin, slug: string | undefined): Refusal<"forge.accounts.add"> | null => {
    if (forgeAccountEver(reader, forgeAccountId)) return conflict("exists", `A forge account ${forgeAccountId} was added already.`, { forgeAccountId });
    const holder = originHolder(reader, origin);
    if (holder !== null) return conflict("origin_held", `${origin} is already held by another forge account on this environment.`, { origin, forgeAccountId: holder });
    return slug === undefined ? null : slugTaken(slug);
  };

  const verificationFailed = (origin: ForgeOrigin, answer: Extract<IdentityAnswer, { outcome: "refused" }>) =>
    ({ code: "verification_failed", message: `${answer.message} Nothing was stored.`, data: { origin, status: answer.status } }) as const;

  const sourceUnavailable = (connectionId: string, problem: ForgeProblem) =>
    ({ code: "credential_source_unavailable", message: `${problem.message} Nothing was changed.`, data: { connectionId } }) as const;

  /** A command's rejection, answered as the handler it prepares. */
  const rejecting =
    <N extends MethodName>(rejected: Refusal<N>) =>
    (): CommandAnswer<ResultOf<N>, ErrorOf<N>["code"]> => ({ aggregate: stream, rejected });

  /**
   * Takes a token sent once as it arrives: registered at once, released
   * unless the command is accepted. Answers what registers it again once its
   * login is known, which is the registration a forge account then holds.
   */
  const arrive = (forgeAccountId: string, token: string, context: PrepareContext) => {
    const arrival = scrub.register(token, { owner: `forge:${forgeAccountId}` });
    context.onUndo(arrival);
    return (kind: ForgeKind, login: string | null): ScrubRelease => {
      const release = register(forgeAccountId, token, kind, login);
      context.onUndo(release);
      arrival();
      return release;
    };
  };

  /** Writes `token` to a new vault entry before the command's transaction, deleted again unless the command is accepted. */
  const store = async (forgeAccountId: string, token: string, context: PrepareContext): Promise<string> => {
    const entry = newEntry(forgeAccountId);
    context.onUndo(() => vault.delete(entry));
    await vault.set(entry, token);
    return entry;
  };

  /** A stored token's source: one a client's `gh` handed over names that client session, and says it does not follow `gh`'s rotations. */
  const storedSource = (provenance: "pasted" | "client-gh" | "imported", entry: string, context: PrepareContext): ForgeCredentialSource => {
    if (provenance !== "client-gh") return { kind: "stored", provenance, entry };
    const clientSessionId = context.clientSession.id;
    return { kind: "stored", provenance, entry, handedOverBy: { clientSessionId, label: clientSessionLabel(clientSessionId) ?? "" }, followsGhRotations: false };
  };

  /** A credential given to an add or update, heard from the forge before the transaction. */
  type Checked =
    | { readonly rejected: CommandRejection<"verification_failed" | "credential_source_unavailable"> }
    | {
        readonly rejected?: undefined;
        readonly source: ForgeCredentialSource;
        /** Who it answered as; null when it did not reach the forge's identity endpoint or the forge did not answer. */
        readonly identity: ForgeIdentity | null;
        readonly problem: ForgeProblem | null;
        /** The registration a stored token keeps while the vault holds it; null for every other source. */
        readonly held: ScrubRelease | null;
      };

  /**
   * Checks a given credential as the forge account `target` names it: a
   * token sent once is asked about and written to the vault; `gh` and a
   * reference are read for this one operation and asked about, their tokens
   * let go again at once; none asks nothing. A refusal stores nothing; a
   * reference that cannot be read is `credential_source_unavailable`; a `gh`
   * that gives no token, or a forge that does not answer, leaves a problem.
   */
  const check = async (
    target: Omit<CredentialTarget, "credential">,
    given: ForgeAddCredential | ImportedCredential,
    context: PrepareContext,
    formed: ((kind: ForgeKind, login: string | null) => ScrubRelease) | null,
    purpose: string,
  ): Promise<Checked> => {
    const { id, origin, kind } = target;
    const answered = (answer: Exclude<IdentityAnswer, { outcome: "refused" }>) => ({
      identity: answer.outcome === "identified" ? answer.identity : null,
      problem: answer.outcome === "unreachable" ? unreachable(answer.message) : null,
    });
    if (given.kind === "none") return { source: { kind: "none" }, identity: null, problem: needsCredential(), held: null };
    if (given.kind === "stored") {
      const answer = await identify(kind, origin, given.token);
      if (answer.outcome === "refused") return { rejected: verificationFailed(origin, answer) };
      const entry = await store(id, given.token, context);
      const { identity, problem } = answered(answer);
      return { source: storedSource(given.provenance, entry, context), identity, problem, held: formed?.(kind, identity?.login ?? target.login) ?? null };
    }
    const source: ForgeCredentialSource = given.kind === "gh" ? { kind: "gh", login: given.login } : { kind: "reference", reference: given.reference };
    const read = await readCredential({ ...target, credential: source }, purpose);
    if (read.outcome === "unavailable") {
      if (source.kind === "reference") return { rejected: sourceUnavailable(source.reference.connectionId, read.problem) };
      return { source, identity: null, problem: read.problem, held: null };
    }
    let answer: IdentityAnswer;
    try {
      answer = await identify(kind, origin, read.token);
    } finally {
      read.release();
    }
    if (answer.outcome === "refused") return { rejected: verificationFailed(origin, answer) };
    return { source, ...answered(answer), held: null };
  };

  /** Refuses `gh` and a client's `gh` for a forge account that is not GitHub's: `gh` holds GitHub tokens alone. */
  const refuseGhOffGitHub = (given: ForgeAddCredential | ImportedCredential, kind: ForgeKind): void => {
    if (kind === "github" || !(given.kind === "gh" || (given.kind === "stored" && given.provenance === "client-gh"))) return;
    const message = "gh holds GitHub tokens alone: give a Forgejo or Gitea forge account a pasted token or a key-manager reference.";
    throw new ContractError(invalidParams([{ code: "custom", path: ["credential"], message }], message));
  };

  const add: ForgeAdd = {
    async prepare(params, context) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const given = params.credential;
      const formed = given.kind === "stored" ? arrive(forgeAccountId, given.token, context) : null;
      const remote = normaliseRemote(params.url);
      if (remote === null) {
        const message = "The URL names no forge: give its https or http address, an ssh or scp-like remote, or host:port.";
        throw new ContractError(invalidParams([{ code: "custom", path: ["url"], message }], message));
      }
      const { origin } = remote;
      const kind = params.kind ?? (origin === GITHUB_ORIGIN ? "github" : undefined);
      if (kind === undefined) {
        const message = "Name the forge's kind (github, forgejo or gitea): only github.com is known by its name.";
        throw new ContractError(invalidParams([{ code: "custom", path: ["kind"], message }], message));
      }
      refuseGhOffGitHub(given, kind);
      const doomed = addRefusal(forgeAccountId, origin, params.slug);
      if (doomed !== null) return rejecting<"forge.accounts.add">(doomed);

      const checked = await check({ id: forgeAccountId, origin, kind, login: null }, given, context, formed, "add");
      if (checked.rejected !== undefined) return rejecting<"forge.accounts.add">(checked.rejected);

      return (_params, command) => {
        // Read again in the transaction: another command may have taken the id, the origin or the slug meanwhile.
        const refused = addRefusal(forgeAccountId, origin, params.slug);
        if (refused !== null) return { aggregate: stream, rejected: refused };
        const accounts = listForgeAccounts(reader);
        const slug = params.slug ?? deriveForgeSlug(origin, accounts.map((account) => account.slug));
        const current = primaryForgeAccount(reader);
        // The first forge account becomes primary (ADR 0012), whatever the call says; a later one only when asked.
        const primary = accounts.length === 0 || params.primary === true;
        const payload: ForgeAccountAddedPayload = {
          forgeAccountId,
          origin,
          aliases: [],
          kind,
          slug,
          identity: checked.identity,
          credential: checked.source,
          primary,
          clearedPrimary: primary ? current : null,
          problem: checked.problem,
          copiedFrom: params.copiedFrom ?? null,
        };
        log.append(stream, [{ type: "forge.account.added", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => hold(forgeAccountId, checked.held));
        return { aggregate: stream, result: { account: recordOf(forgeAccountId) } };
      };
    },
  };

  /** Another user id than the forge account's, answered by its new credential. */
  const identityMismatch = (forgeAccountId: string, expected: ForgeIdentity, found: ForgeIdentity) =>
    ({
      code: "identity_mismatch",
      message: `The new credential answers as ${found.login} (user ${found.userId}), not ${expected.login} (user ${expected.userId}): nothing was changed.`,
      data: { forgeAccountId, expected, found },
    }) as const;

  /** Why an update cannot go ahead as the store is now; null when it can. */
  const updateRefusal = (forgeAccountId: string, slug: string | undefined, found: ForgeIdentity | null): Refusal<"forge.accounts.update"> | null => {
    const current = liveForgeAccount(reader, forgeAccountId);
    if (current === null) return notFound(forgeAccountId);
    const taken = slug === undefined ? null : slugTaken(slug, forgeAccountId);
    if (taken !== null) return taken;
    if (found !== null && current.identity !== null && found.userId !== current.identity.userId) return identityMismatch(forgeAccountId, current.identity, found);
    return null;
  };

  const update: ForgeService["update"] = {
    async prepare(params, context) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const given = params.credential;
      const formed = given?.kind === "stored" ? arrive(forgeAccountId, given.token, context) : null;
      const doomed = updateRefusal(forgeAccountId, params.slug, null);
      if (doomed !== null) return rejecting<"forge.accounts.update">(doomed);
      let replacement: Extract<Checked, { rejected?: undefined }> | null = null;
      if (given !== undefined) {
        const { kind, origin, identity } = recordOf(forgeAccountId);
        refuseGhOffGitHub(given, kind);
        const checked = await check({ id: forgeAccountId, origin, kind, login: identity?.login ?? null }, given, context, formed, "update");
        if (checked.rejected !== undefined) return rejecting<"forge.accounts.update">(checked.rejected);
        const mismatch = updateRefusal(forgeAccountId, params.slug, checked.identity);
        if (mismatch !== null) return rejecting<"forge.accounts.update">(mismatch);
        replacement = checked;
      }
      const replacing = replacement;

      return (_params, command) => {
        const found = replacing?.identity ?? null;
        const refused = updateRefusal(forgeAccountId, params.slug, found);
        if (refused !== null) return { aggregate: stream, rejected: refused };
        const current = recordOf(forgeAccountId);
        const payload: ForgeAccountUpdatedPayload = { forgeAccountId };
        const changes: Partial<ForgeAccountUpdatedPayload> = {
          ...(params.slug !== undefined && params.slug !== current.slug && { slug: params.slug }),
          ...(replacing !== null && { credential: replacing.source, ...(found !== null && { identity: found }), problem: replacing.problem }),
        };
        if (Object.keys(changes).length === 0) return { aggregate: stream, result: { account: current } };
        log.append(stream, [{ type: "forge.account.updated", payload: { ...payload, ...changes } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        if (replacing !== null) {
          command.tx.afterCommit(() => {
            hold(forgeAccountId, replacing.held);
            if (current.credential.kind === "stored") deleteEntry(current.credential.entry);
          });
        }
        return { aggregate: stream, result: { account: recordOf(forgeAccountId) } };
      };
    },
  };

  return {
    async start() {
      const entries = new Set<string>();
      for (const account of listForgeAccounts(reader)) {
        if (account.credential.kind !== "stored") continue;
        const { entry } = account.credential;
        entries.add(entry);
        try {
          const token = await vault.get(entry);
          if (token !== undefined) hold(account.id, register(account.id, token, account.kind, account.identity?.login ?? null));
        } catch (error) {
          console.error(`Reading the vault entry ${entry} of the forge account ${account.slug} failed:`, error);
        }
      }
      try {
        for (const key of await vault.keys()) if (key.startsWith(VAULT_PREFIX) && !entries.has(key)) await vault.delete(key);
      } catch (error) {
        console.error("Deleting the vault entries of forge accounts that are gone failed; the next start tries again:", error);
      }
    },

    list: () => listForgeAccounts(reader),

    async resolveCredential(forgeAccountId, purpose) {
      const account = liveForgeAccount(reader, forgeAccountId.toLowerCase());
      if (account === null) return null;
      return readCredential({ ...account, login: account.identity?.login ?? null }, purpose);
    },

    probeGh: () => gh.probe(),

    add,

    update,

    remove(params, context: CommandContext) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const current = liveForgeAccount(reader, forgeAccountId);
      if (current === null) return { aggregate: stream, rejected: notFound(forgeAccountId) };
      log.append(stream, [{ type: "forge.account.removed", payload: { forgeAccountId } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      context.tx.afterCommit(() => {
        hold(forgeAccountId, null);
        if (current.credential.kind === "stored") deleteEntry(current.credential.entry);
      });
      return { aggregate: stream, result: { forgeAccountId } };
    },

    setPrimary(params, context: CommandContext) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const current = liveForgeAccount(reader, forgeAccountId);
      if (current === null) return { aggregate: stream, rejected: notFound(forgeAccountId) };
      if (current.primary) return { aggregate: stream, result: { account: current } };
      const cleared = primaryForgeAccount(reader);
      log.append(stream, [{ type: "forge.account.primary-set", payload: { forgeAccountId, cleared } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      return { aggregate: stream, result: { account: recordOf(forgeAccountId) } };
    },

    close() {
      for (const release of held.values()) release();
      held.clear();
    },
  };
};

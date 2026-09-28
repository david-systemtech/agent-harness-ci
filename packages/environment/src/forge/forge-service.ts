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
  type ForgeIdentity,
  type ForgeKind,
  type ForgeOrigin,
  type ForgeProblem,
  type MethodName,
  type ResultOf,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PrepareContext, PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { forgeAccountEver, listForgeAccounts, liveForgeAccount, originHolder, primaryForgeAccount, slugHolder } from "./forge-store.js";
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
}

type Refusal<N extends MethodName> = CommandRejection<ErrorOf<N>["code"]>;

export interface ForgeService {
  /** Registers every stored token the vault holds with its forms, and deletes the forge entries no forge account holds; startup runs it once, before the wire opens. */
  start(): Promise<void>;
  /** The forge accounts, in the order they were added. */
  list(): ForgeAccountRecord[];
  readonly add: PreparedCommand<"forge.accounts.add">;
  readonly update: PreparedCommand<"forge.accounts.update">;
  readonly remove: MethodHandler<"forge.accounts.remove">;
  readonly setPrimary: MethodHandler<"forge.accounts.setPrimary">;
  /** Lets go of every token's registration. */
  close(): void;
}

export const createForgeService = (options: ForgeServiceOptions): ForgeService => {
  const { log, clock, vault, scrub } = options;
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

  /** Holds `release` as the forge account's registration, letting go of the one it replaces. */
  const hold = (forgeAccountId: string, release: ScrubRelease): void => {
    held.get(forgeAccountId)?.();
    held.set(forgeAccountId, release);
  };

  /** Deletes a vault entry a committed command let go of; one left behind is deleted by the next start. */
  const deleteEntry = (entry: string): void => {
    vault.delete(entry).catch((error: unknown) => console.error(`Deleting the vault entry ${entry} failed; the next start deletes it:`, error));
  };

  const identify = (kind: ForgeKind, origin: ForgeOrigin, token: string): Promise<IdentityAnswer> => forgeProvider(kind, providerOptions).identity(origin, token);

  /** The problem a forge that did not answer leaves, since now. */
  const unreachable = (message: string): ForgeProblem => ({ kind: "unreachable", since: clock.now().toISOString(), message });

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

  /** A command's rejection, answered as the handler it prepares. */
  const rejecting =
    <N extends MethodName>(rejected: Refusal<N>) =>
    (): CommandAnswer<ResultOf<N>, ErrorOf<N>["code"]> => ({ aggregate: stream, rejected });

  /**
   * Takes a pasted token as it arrives: registered at once, released unless
   * the command is accepted. Answers what registers it again once its login
   * is known, which is the registration a forge account then holds.
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

  const add: ForgeService["add"] = {
    async prepare(params, context) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const { token } = params.credential;
      const formed = arrive(forgeAccountId, token, context);
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
      const doomed = addRefusal(forgeAccountId, origin, params.slug);
      if (doomed !== null) return rejecting<"forge.accounts.add">(doomed);

      const answer = await identify(kind, origin, token);
      if (answer.outcome === "refused") return rejecting<"forge.accounts.add">(verificationFailed(origin, answer));
      const identity = answer.outcome === "identified" ? answer.identity : null;
      const problem = answer.outcome === "unreachable" ? unreachable(answer.message) : null;
      const entry = await store(forgeAccountId, token, context);
      const release = formed(kind, identity?.login ?? null);

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
          identity,
          credential: { kind: "stored", provenance: "pasted", entry },
          primary,
          clearedPrimary: primary ? current : null,
          problem,
          copiedFrom: null,
        };
        log.append(stream, [{ type: "forge.account.added", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => hold(forgeAccountId, release));
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

  /** A new credential, checked and stored before the transaction. */
  interface Replacement {
    readonly entry: string;
    readonly answer: Exclude<IdentityAnswer, { outcome: "refused" }>;
    readonly release: ScrubRelease;
  }

  const update: ForgeService["update"] = {
    async prepare(params, context) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const token = params.credential?.token;
      const formed = token === undefined ? null : arrive(forgeAccountId, token, context);
      const doomed = updateRefusal(forgeAccountId, params.slug, null);
      if (doomed !== null) return rejecting<"forge.accounts.update">(doomed);
      let replacement: Replacement | null = null;
      if (token !== undefined && formed !== null) {
        const { kind, origin } = recordOf(forgeAccountId);
        const answer = await identify(kind, origin, token);
        if (answer.outcome === "refused") return rejecting<"forge.accounts.update">(verificationFailed(origin, answer));
        const mismatch = updateRefusal(forgeAccountId, params.slug, answer.outcome === "identified" ? answer.identity : null);
        if (mismatch !== null) return rejecting<"forge.accounts.update">(mismatch);
        const entry = await store(forgeAccountId, token, context);
        replacement = { entry, answer, release: formed(kind, answer.outcome === "identified" ? answer.identity.login : null) };
      }
      const replacing = replacement;

      return (_params, command) => {
        const found = replacing?.answer.outcome === "identified" ? replacing.answer.identity : null;
        const refused = updateRefusal(forgeAccountId, params.slug, found);
        if (refused !== null) return { aggregate: stream, rejected: refused };
        const current = recordOf(forgeAccountId);
        const payload: ForgeAccountUpdatedPayload = { forgeAccountId };
        const changes: Partial<ForgeAccountUpdatedPayload> = {
          ...(params.slug !== undefined && params.slug !== current.slug && { slug: params.slug }),
          ...(replacing !== null && {
            credential: { kind: "stored", provenance: "pasted", entry: replacing.entry },
            ...(found !== null && { identity: found }),
            problem: replacing.answer.outcome === "unreachable" ? unreachable(replacing.answer.message) : null,
          }),
        };
        if (Object.keys(changes).length === 0) return { aggregate: stream, result: { account: current } };
        log.append(stream, [{ type: "forge.account.updated", payload: { ...payload, ...changes } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        if (replacing !== null) {
          command.tx.afterCommit(() => {
            hold(forgeAccountId, replacing.release);
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

    add,

    update,

    remove(params, context: CommandContext) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const current = liveForgeAccount(reader, forgeAccountId);
      if (current === null) return { aggregate: stream, rejected: notFound(forgeAccountId) };
      log.append(stream, [{ type: "forge.account.removed", payload: { forgeAccountId } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      context.tx.afterCommit(() => {
        held.get(forgeAccountId)?.();
        held.delete(forgeAccountId);
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

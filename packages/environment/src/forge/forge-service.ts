import { randomUUID } from "node:crypto";
import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  GITHUB_ORIGIN,
  deriveForgeSlug,
  forgeGitUsername,
  forgeTokenPages,
  invalidParams,
  normaliseRemote,
  type ErrorOf,
  type ForgeAccountAddedPayload,
  type ForgeAccountRecord,
  type ForgeAccountUpdatedPayload,
  type ForgeAddCredential,
  type ForgeAlias,
  type ForgeCapabilities,
  type ForgeCredentialSource,
  type ForgeIdentity,
  type ForgeKind,
  type ForgeOrigin,
  type ForgeProblem,
  type ForgeTokenInformation,
  type GhProbe,
  type KeyManagerReferenceHolder,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { MoveSource } from "../key-managers/moves.js";
import { noKeyManagerConnections, type KeyManagerRegistry, type ReferenceRefusal } from "../key-managers/registry.js";
import type { ScrubRegistry, ScrubRelease } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { Address } from "../serve/http.js";
import type { CommandAnswer, CommandContext, CommandRejection, MethodHandler, PrepareContext, PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import type { ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import {
  credentialGenerations,
  forgeAccountEver,
  isInjected,
  listForgeAccounts,
  liveForgeAccount,
  originHolder,
  primaryForgeAccount,
  slugHolder,
  type MissingOrigin,
} from "./forge-store.js";
import type { ManagedGh } from "./gh.js";
import { keepSince } from "./verification.js";
import { FORGE_ACTOR, createVerifier } from "./verifier.js";
import { createEntityTags } from "./forge-http.js";
import { FORGE_CALL_TIMEOUT_MS, forgeProvider, type ForgeFetch, type IdentityAnswer, type ProviderOptions } from "./providers.js";
import type { GitConfigEntry } from "./git-helper.js";
import { createHarnessGit, type ForgeGitAnswer, type ForgeGitRequest } from "./harness-git.js";
import { createMissingOrigins } from "./missing-origins.js";
import { createRunSecrets, type RunSecrets } from "./run-secrets.js";
import { createForgeOperations, type ForgeOperations } from "./operations.js";
import { detectForge, unreadable, type Detection } from "./detection.js";
import {
  accountWords,
  adviceLine,
  alreadyConnected,
  cannotListOrganisations,
  noToken,
  notAnAlias,
  notAnswering,
  savedTokenUnreadable,
  siteOf,
  tokenOfOther,
  tokenRefused,
  tokenRefusedAtAdd,
  unreachableAtAdd,
} from "./lines.js";
import { createPullRequestLinks, type PullRequestLinks } from "./pull-request-links.js";
import { createForgeMoveSource } from "./move-source.js";
import { createForgeInjection } from "./injection.js";
import { forgesSection } from "./orientation.js";
import type { OrientationSection } from "../instructions/orientation.js";

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
 * - **Aliases** (#311) are asked on their own origin with the credential an
 *   add or update is given, or the one held, and accepted only as the same
 *   login and user id (`alias_identity_mismatch`); one another forge account
 *   holds is `origin_held`.
 * - **Verification** (#311) is the verifier's (`verifier.ts`): after
 *   startup's gate, every fifteen minutes, on `forge.accounts.verify` and
 *   once a credential is given; Set up's Forges checks ask only for a forge
 *   account whose findings are older than they take, and never past a
 *   forge's pause (#680). The records answered carry the verified-at
 *   times it keeps beside them. The state import's credential probe is one
 *   verification with no record.
 * - **git** (#314): the run-scoped secrets the credential route
 *   (`credential-route.ts`) serves; the harness's own git operation
 *   (`harness-git.ts`), through the credential helper where a forge account
 *   serves the origin and anonymously where none does; the origins found
 *   missing (`missing-origins.ts`); and git's rejections, each reported and
 *   verified again.
 * - **Operations** (#316): repositories, issues, pull requests, releases
 *   and a file on a branch (`operations.ts`), each reading the credential
 *   for itself, and each write teaching its capability.
 * - **Detection** (#313): which forge a URL is on, asked with no credential
 *   (`detection.ts`), with the token pages its kind offers; an add without
 *   a kind detects it before the credential goes anywhere. The owners a
 *   forge account may create a repository under are read live, never kept.
 * - **A session's pull requests** (#317): linked, found at a run's end and
 *   kept current through the operations (`pull-request-links.ts`).
 * - **Move** (#371): the forge accounts holding a pasted token are a Move
 *   source (`move-source.ts`), swapped to a reference through `update`.
 * - **Runs reach the forge** (#315): the supplier of every provider
 *   process's and terminal's forge variables and credential helper
 *   (`injection.ts`), which the environment registers with its process
 *   environment.
 * - **Runs are told of the forges** (#318): the orientation block's forges
 *   section (`orientation.ts`), from the read model and never a clock, and
 *   under the run's injection answer (#714).
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
  /** The environment's own `gh`: the one the Managed tools registry's row found (#373). */
  readonly gh: ManagedGh;
  /** The key-manager registry's resolve seam, the environment's over its connections (#370); preset: no key-manager connection, so every reference is unavailable. */
  readonly keyManagers?: KeyManagerRegistry;
  /** A client session's label, which a token its client's `gh` handed over records beside its id. */
  readonly clientSessionLabel: (clientSessionId: string) => string | undefined;
  /**
   * The repository identities this environment knows (`https://<host>/<owner>/<name>`), most recently used first,
   * which a verification probes its reads on: a session's now, banks and skill sources when they exist. Preset: none.
   */
  readonly knownRepositories?: () => readonly string[];
  /**
   * The command line that runs the `agent-harness` binary before its verb,
   * which git names as its credential helper (`git-credential <slug>`): the
   * one `serve` runs as. Absent, the harness's git fails on an origin a
   * forge account covers, having no helper to name, and no run or terminal
   * is given the forge's variables (`processEnvironment` is undefined).
   */
  readonly harnessCommand?: readonly string[];
  /** The environment's loopback address, where the helper asks; undefined until it listens. */
  readonly address?: () => Address | undefined;
  /** Configuration the harness's git is given after its own (a test's `insteadOf`); preset none. */
  readonly gitConfig?: readonly GitConfigEntry[];
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

/** What the state import asks of a credential it carried over, in process (#56, ADR 0036): nothing is stored or recorded. */
export interface CredentialProbeRequest {
  /** The forge's URL in any form, or a repository's on it (a bank's remote), whose reads are then probed on that repository. */
  readonly url: string;
  /** The forge's kind; optional for github.com. */
  readonly kind?: Exclude<ForgeKind, "gitlab">;
  readonly token: string;
}

/** What a credential probe found: who the token is, what it may read, what it says of itself, and what is wrong. */
export interface CredentialProbe {
  readonly origin: ForgeOrigin;
  readonly identity: ForgeIdentity | null;
  readonly capabilities: ForgeCapabilities;
  readonly tokenInformation: ForgeTokenInformation | null;
  readonly problem: ForgeProblem | null;
}

/** A forge account's credential for one operation. */
export type ForgeCredential =
  /** The token, and the release that ends its registration for scrubbing: call it when the operation ends. */
  | { readonly outcome: "resolved"; readonly token: string; readonly release: ScrubRelease }
  /**
   * No token: `needs-credential` for a copy awaiting one, `credential-unavailable` for `gh`, a key manager or the vault
   * giving none; a key-manager reference's with the refusal its resolve answered, which an add or update answers.
   */
  | { readonly outcome: "unavailable"; readonly problem: ForgeProblem; readonly refusal?: ReferenceRefusal };

export interface ForgeService extends ForgeOperations {
  /** Registers every stored token the vault holds with its forms, and deletes the forge entries no forge account holds; startup runs it once, before the wire opens. */
  start(): Promise<void>;
  /** The forge accounts, in the order they were added. */
  list(): ForgeAccountRecord[];
  /** The forge accounts whose credential is a reference through the key-manager connection `connectionId`, which hold back its removal (#370). */
  referenceHolders(connectionId: string): KeyManagerReferenceHolder[];
  /**
   * Reads the forge account's credential for one operation, `purpose` in a
   * few words: every harness operation on a forge reads it again, and calls
   * the release when it ends. Null when the environment does not hold the
   * forge account.
   */
  resolveCredential(forgeAccountId: string, purpose: string): Promise<ForgeCredential | null>;
  /** What the environment's own `gh` is: installed, its version against the minimum, and who it is signed in as. */
  probeGh(): Promise<GhProbe>;
  /** After startup's gate: verifies every forge account now, then every fifteen minutes. */
  startVerifying(): void;
  /** Verifies one forge account now, or every one (`forge.accounts.verify`), and answers every record after; `not_found` for one the environment does not hold. */
  verify(forgeAccountId?: string): Promise<ForgeAccountRecord[]>;
  /**
   * Every record as Set up's Forges checks read it (#680): each forge account
   * whose last verification ended `maxAgeMs` ago or more is verified first,
   * unless the forge asked for a pause that has not passed; every other is
   * answered as its last verification found it.
   */
  verifiedWithin(maxAgeMs: number): Promise<ForgeAccountRecord[]>;
  /**
   * The state import's in-process credential probe: one verification of a
   * token it carried over, without a record, answering identity and
   * capabilities. The token is held as a secret while it runs, and nothing
   * is stored. `invalid_params` for a URL that names no forge, or no kind
   * for one other than github.com.
   */
  probeCredential(request: CredentialProbeRequest): Promise<CredentialProbe>;
  /** An import may reuse an alias only when this owner has verified it as the same identity. */
  importTarget(origin: ForgeOrigin): ForgeAccountRecord | null;
  canImportOrigin(origin: ForgeOrigin): boolean;
  /** Carries a secret-free import record without resolving credentials or verifying aliases. */
  importRecord(params: { readonly forgeAccountId: string; readonly origin: ForgeOrigin; readonly kind: Exclude<ForgeKind, "gitlab">; readonly credential: Extract<ForgeCredentialSource, { kind: "none" | "reference" }> }, context: CommandContext): CommandAnswer<{ readonly targetId: string; readonly carried: boolean }>;
  readonly add: ForgeAdd;
  readonly update: PreparedCommand<"forge.accounts.update">;
  readonly remove: MethodHandler<"forge.accounts.remove">;
  readonly setPrimary: MethodHandler<"forge.accounts.setPrimary">;
  /** The run-scoped secrets the credential route serves (#314): minted per harness git operation, provider process or terminal. */
  readonly secrets: RunSecrets;
  /**
   * The harness's own git on a forge (#314): a clone, fetch or push against
   * the canonical origin's URL, through the credential helper on an origin a
   * forge account serves, anonymously on one none covers, where a forge that
   * asks for a credential refuses it `forge_account_missing`.
   */
  git(request: ForgeGitRequest): Promise<ForgeGitAnswer>;
  /**
   * git refused the credential the helper gave for `origin` (its `erase`):
   * `forge.account.git-rejected` as `system:forge`, then a verification of
   * the forge account. Nothing is forgotten; one the environment no longer
   * holds records nothing.
   */
  gitRejected(forgeAccountId: string, origin: ForgeOrigin): void;
  /** The origins a harness operation was refused on that count now, for the Forges step's coverage check: recorded within seven days, and covered by no forge account since. */
  missingOrigins(): MissingOrigin[];
  /**
   * Which forge a URL in any form is on (`forge.detect`): its origin, kind
   * and version, and the token pages with what to grant. `kind_unsupported`
   * for GitLab, `not_a_forge`, `unreachable`, and `invalid_params` for a URL
   * that is no remote.
   */
  detect(url: string): Promise<ResultOf<"forge.detect">>;
  /**
   * The owners the forge account may create a repository under
   * (`forge.orgs.list`), read from the forge now: `not_found` for one the
   * environment does not hold, `credential_unavailable`,
   * `verification_failed` for a refusal, `unreachable`.
   */
  owners(forgeAccountId: string): Promise<ResultOf<"forge.orgs.list">>;
  /** A session's pull requests (#317): linked, found at a run's end, and kept current. */
  readonly links: PullRequestLinks;
  /** The forge accounts holding a pasted token, as a Move takes them into a key manager (#371). */
  readonly moveSource: MoveSource;
  /**
   * The forge's part of every provider process and terminal (#315): the
   * variables, git's helper and the run-scoped secret, which the
   * environment registers with its process environment. Undefined when the
   * service was given no `harnessCommand` for git to name.
   */
  readonly processEnvironment: ProcessEnvironmentSupplier | undefined;
  /**
   * The orientation block's forges section (#318): which forges runs reach,
   * which is primary, the variables and API base of each, what each cannot
   * do and what was left out, from the read model and never a clock; for a
   * run denied injection, who denied it in place of the variables (#714).
   * Undefined, as `processEnvironment` is, when the service was given no
   * `harnessCommand` for git to name.
   */
  readonly orientation: OrientationSection | undefined;
  /** Stops the verifications, voids every run-scoped secret and lets go of every token's registration. */
  close(): void;
}

export const createForgeService = (options: ForgeServiceOptions): ForgeService => {
  const { log, clock, vault, scrub, clientSessionLabel, gh } = options;
  const keyManagers = options.keyManagers ?? noKeyManagerConnections;
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  const providerOptions: ProviderOptions = {
    fetch: options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),
    timeoutMs: options.callTimeoutMs ?? FORGE_CALL_TIMEOUT_MS,
    now: () => clock.now(),
    entityTags: createEntityTags(),
  };
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The scrub registration of each stored token the environment holds, by forge account. */
  const held = new Map<string, ScrubRelease>();
  const secrets = createRunSecrets(scrub);
  const missing = createMissingOrigins({ log, clock, stream, reader, accounts: () => listForgeAccounts(reader) });
  const git = createHarnessGit({
    accounts: () => listForgeAccounts(reader),
    secrets,
    scrub,
    command: options.harnessCommand,
    address: options.address ?? (() => undefined),
    originMissing: (origin, operation, repository) => missing.record(origin, operation, repository),
    originAnswered: (origin, operation, repository) => missing.answered(origin, operation, repository),
    ...(options.gitConfig !== undefined && { config: options.gitConfig }),
  });

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

  /** A problem of `kind` since now: its plain line (setup-copy.md §5.6), and the raw facts behind it. */
  const problemNow = (kind: ForgeProblem["kind"], message: string, details: readonly string[] = []): ForgeProblem => ({
    kind,
    since: clock.now().toISOString(),
    message,
    ...(details.length > 0 && { details: [...details] }),
  });

  /** The problem a forge that did not answer an add leaves, since now. */
  const unreachable = (origin: ForgeOrigin, answer: Extract<IdentityAnswer, { outcome: "unreachable" }>): ForgeProblem =>
    problemNow("unreachable", adviceLine(notAnswering(siteOf(origin), answer.status)), [answer.message]);

  const needsCredential = (origin: ForgeOrigin): ForgeProblem => problemNow("needs-credential", noToken(siteOf(origin)));

  /** The host `gh` names an origin's instance by: github.com, or an Enterprise host with its port. */
  const ghHost = siteOf;

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
        return { outcome: "unavailable", problem: needsCredential(target.origin) };
      case "stored": {
        let token: string | undefined;
        try {
          token = await vault.get(credential.entry);
        } catch (error) {
          console.error(`Reading the vault entry ${credential.entry} failed:`, error);
        }
        if (token === undefined) {
          return {
            outcome: "unavailable",
            problem: problemNow("credential-unavailable", savedTokenUnreadable(accountWords(target.origin, target.login), false), [`This computer's vault holds no entry ${credential.entry}.`]),
          };
        }
        return { outcome: "resolved", token, release: () => undefined };
      }
      case "gh": {
        const answer = await gh.token(ghHost(target.origin), credential.login);
        if (answer.outcome === "unavailable") return { outcome: "unavailable", problem: problemNow("credential-unavailable", answer.message, answer.details) };
        return { outcome: "resolved", token: answer.token, release: register(id, answer.token, target.kind, target.login) };
      }
      case "reference": {
        const answer = await keyManagers.resolve({ reference: credential.reference, owner: `forge:${id}`, purpose });
        if (answer.outcome === "unavailable") {
          return { outcome: "unavailable", problem: problemNow("credential-unavailable", savedTokenUnreadable(accountWords(target.origin, target.login), true), [answer.message]), refusal: answer.code };
        }
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

  /** Reads a held forge account's credential for one operation, with the login the forge knows it by. */
  const readHeld = (account: ForgeAccountRecord, purpose: string): Promise<ForgeCredential> => readCredential({ ...account, login: account.identity?.login ?? null }, purpose);

  const verifier = createVerifier({
    log,
    clock,
    stream,
    reader,
    provider: (kind) => forgeProvider(kind, providerOptions),
    readCredential: readHeld,
    knownRepositories: options.knownRepositories ?? (() => []),
    budgetMs: providerOptions.timeoutMs,
    loginChanged: (account) => void holdStored(account),
  });

  const operations = createForgeOperations({
    log,
    clock,
    stream,
    reader,
    scrub,
    provider: (kind) => forgeProvider(kind, providerOptions),
    detect: (origin) => detectForge(origin, providerOptions),
    readCredential: readHeld,
    verifier,
    originMissing: (origin, operation, repository) => missing.record(origin, operation, repository),
    originAnswered: (origin, operation, repository) => missing.answered(origin, operation, repository),
  });

  const links = createPullRequestLinks({
    log,
    clock,
    reader,
    accounts: () => listForgeAccounts(reader),
    pullRequests: operations.pullRequests,
    repositories: operations.repositories,
  });

  /** Holds a stored token's registration again with its forms for the forge account as it is now: a changed login names another Basic-auth form. */
  const holdStored = async (account: ForgeAccountRecord): Promise<void> => {
    if (account.credential.kind !== "stored") return;
    const { entry } = account.credential;
    try {
      const token = await vault.get(entry);
      if (token !== undefined) hold(account.id, register(account.id, token, account.kind, account.identity?.login ?? null));
    } catch (error) {
      console.error(`Reading the vault entry ${entry} of the forge account ${account.slug} failed:`, error);
    }
  };

  /** The forge accounts, each with the verified-at times kept beside its record. */
  const listSeen = (): ForgeAccountRecord[] => listForgeAccounts(reader).map(verifier.seen);

  const recordOf = (forgeAccountId: string): ForgeAccountRecord => {
    const record = liveForgeAccount(reader, forgeAccountId);
    if (record === null) throw new Error(`The forge account ${forgeAccountId} is not in the store after a command applied to it.`);
    return verifier.seen(record);
  };

  const notFound = (forgeAccountId: string) =>
    ({ code: "not_found", message: `No forge account ${forgeAccountId} is on this environment.`, data: { kind: "forge_account", forgeAccountId } }) as const;

  const conflict = (reason: string, message: string, data: Record<string, string>) => ({ code: "conflict", message, data: { reason, ...data } }) as const;

  const slugTaken = (slug: string, except?: string) => {
    const holder = slugHolder(reader, slug);
    return holder === null || holder === except ? null : conflict("slug_taken", `The slug ${slug} is taken by another forge account on this environment.`, { slug, forgeAccountId: holder });
  };

  /** The first of `origins` another forge account than `except` holds, as its canonical origin or an alias, refused `origin_held`; null for none. */
  const originHeld = (origins: readonly ForgeOrigin[], except?: string) => {
    for (const origin of origins) {
      const holder = originHolder(reader, origin);
      if (holder !== null && holder !== except) return conflict("origin_held", alreadyConnected(siteOf(origin)), { origin, forgeAccountId: holder });
    }
    return null;
  };

  /** Why an add cannot go ahead as the store is now: an id used before, an origin or alias held, a slug taken; null when it can. */
  const addRefusal = (forgeAccountId: string, origins: readonly ForgeOrigin[], slug: string | undefined): Refusal<"forge.accounts.add"> | null => {
    if (forgeAccountEver(reader, forgeAccountId)) return conflict("exists", `A forge account ${forgeAccountId} was added already.`, { forgeAccountId });
    return originHeld(origins) ?? (slug === undefined ? null : slugTaken(slug));
  };

  /** An alias whose origin answered as someone else than the forge account, or refused its credential. */
  const aliasMismatch = (origin: ForgeOrigin, expected: ForgeIdentity, found: ForgeIdentity | null, status: number) =>
    ({
      code: "alias_identity_mismatch",
      message: notAnAlias(siteOf(origin), expected.login, found === null),
      data: { origin, expected, found, status },
    }) as const;

  /**
   * The alias origins a command names, each given as a URL in any form:
   * only the origin kept, each once, in the order given; `invalid_params`
   * for one that names no forge or is the forge account's own origin.
   */
  const aliasOrigins = (given: readonly string[] | undefined, origin: ForgeOrigin): ForgeOrigin[] | undefined => {
    if (given === undefined) return undefined;
    const origins: ForgeOrigin[] = [];
    given.forEach((text, index) => {
      const alias = normaliseRemote(text)?.origin;
      const problem = alias === undefined ? "names no forge: give its https or http address" : alias === origin ? "is the forge account's own origin, not an alias of it" : null;
      if (problem !== null) {
        const message = `The alias ${index + 1} ${problem}.`;
        throw new ContractError(invalidParams([{ code: "custom", path: ["aliases", index], message }], message));
      }
      if (alias !== undefined && !origins.includes(alias)) origins.push(alias);
    });
    return origins;
  };

  /**
   * Asks each of `origins` who `token` is, all at once, the credential having answered
   * as `identity` on the forge account's own origin: one answering as the
   * same login and user id is verified now; one that does not answer, or
   * any while the identity is not known, waits unverified; another identity
   * or a refusal is `alias_identity_mismatch`.
   */
  const checkAliases = async (kind: ForgeKind, token: string, identity: ForgeIdentity | null, origins: readonly ForgeOrigin[]) => {
    const at = clock.now().toISOString();
    // Asked all at once, so aliases slow to answer (an offline tailnet address) hold the command up by one call's timeout, not one each.
    const answers = identity === null ? [] : await Promise.all(origins.map((origin) => identify(kind, origin, token)));
    const aliases: ForgeAlias[] = [];
    for (const [index, origin] of origins.entries()) {
      const answer = answers[index];
      if (identity === null || answer === undefined || answer.outcome === "unreachable") {
        aliases.push({ origin, verifiedAt: null });
        continue;
      }
      const found = answer.outcome === "identified" ? answer.identity : null;
      if (found?.login !== identity.login || found.userId !== identity.userId) {
        return { rejected: aliasMismatch(origin, identity, found, answer.outcome === "refused" ? answer.status : 200) };
      }
      aliases.push({ origin, verifiedAt: at });
    }
    return { aliases };
  };

  const verificationFailed = (origin: ForgeOrigin, answer: Extract<IdentityAnswer, { outcome: "refused" }>) =>
    ({ code: "verification_failed", message: tokenRefusedAtAdd(siteOf(origin)), data: { origin, status: answer.status, details: [answer.message] } }) as const;

  /**
   * An add's or update's refusal of a reference that did not resolve: the refusal its resolve answered, in the key
   * manager's own line (the problem's first detail), which names what to check; the problem's plain line says less.
   */
  const referenceRefused = (connectionId: string, refusal: ReferenceRefusal, problem: ForgeProblem) =>
    ({ code: refusal, message: `${problem.details?.[0] ?? problem.message} Nothing was changed.`, data: { connectionId } }) as const;

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

  /** A credential given to an add or update, heard from the forge before the transaction; `Code` is the refusals the caller adds. */
  type Checked<Code extends string> =
    | { readonly rejected: CommandRejection<Code | "verification_failed" | "alias_identity_mismatch" | ReferenceRefusal> }
    | Accepted;

  interface Accepted {
    readonly rejected?: undefined;
    readonly source: ForgeCredentialSource;
    /** Who it answered as; null when it did not reach the forge's identity endpoint or the forge did not answer. */
    readonly identity: ForgeIdentity | null;
    readonly problem: ForgeProblem | null;
    /** The registration a stored token keeps while the vault holds it; null for every other source. */
    readonly held: ScrubRelease | null;
    /** The aliases it was asked about, each verified now or waiting unverified. */
    readonly aliases: readonly ForgeAlias[];
  }

  /** What `check` is given. */
  interface CheckRequest<Code extends string> {
    /** The forge account as the command names it: an add's before it exists, an update's as held. */
    readonly target: Omit<CredentialTarget, "credential">;
    readonly given: ForgeAddCredential | ImportedCredential;
    readonly context: PrepareContext;
    /** What registers a token sent once again with its Basic-auth form, from its arrival; null for a credential that is no token. */
    readonly formed: ((kind: ForgeKind, login: string | null) => ScrubRelease) | null;
    /** What the credential is read for, as the key-manager registry is told: `add`, `update`. */
    readonly purpose: string;
    /** The caller's refusal of the identity the credential answered as, if any, heard before a token is stored. */
    readonly refuse: (found: ForgeIdentity | null) => CommandRejection<Code> | null;
    /** The alias origins to ask about with the credential. */
    readonly aliases: readonly ForgeOrigin[];
  }

  /**
   * Checks a given credential as the forge account `target` names it: a
   * token sent once is asked about and, unless the caller refuses who it
   * answered as, written to the vault; `gh` and a reference are read for
   * this one operation and asked about, their tokens let go again at once;
   * none asks nothing. A refusal stores nothing; a reference that cannot be
   * read is refused as its resolve answered (`credential_source_unavailable`,
   * `reference_not_found`, `reference_denied`); a `gh` that gives no token, or a
   * forge that does not answer, leaves a problem.
   */
  const check = async <Code extends string>({ target, given, context, formed, purpose, refuse, aliases }: CheckRequest<Code>): Promise<Checked<Code>> => {
    const { id, origin, kind } = target;
    const unverified = aliases.map((alias): ForgeAlias => ({ origin: alias, verifiedAt: null }));
    if (given.kind === "none") return { source: { kind: "none" }, identity: null, problem: needsCredential(origin), held: null, aliases: unverified };
    /** What the forge answers `token`: a refusal, the caller's refusal of who answered, an alias's mismatch, or the identity, problem and aliases to record. */
    const heardWith = async (token: string): Promise<Checked<Code> | Omit<Accepted, "source" | "held">> => {
      const answer = await identify(kind, origin, token);
      if (answer.outcome === "refused") return { rejected: verificationFailed(origin, answer) };
      const identity = answer.outcome === "identified" ? answer.identity : null;
      const refused = refuse(identity);
      if (refused !== null) return { rejected: refused };
      const checked = await checkAliases(kind, token, identity, aliases);
      if (checked.rejected !== undefined) return checked;
      return { identity, problem: answer.outcome === "unreachable" ? unreachable(origin, answer) : null, aliases: checked.aliases };
    };
    if (given.kind === "stored") {
      const heard = await heardWith(given.token);
      if (heard.rejected !== undefined) return heard;
      const entry = await store(id, given.token, context);
      return { ...heard, source: storedSource(given.provenance, entry, context), held: formed?.(kind, heard.identity?.login ?? target.login) ?? null };
    }
    const source: ForgeCredentialSource = given.kind === "gh" ? { kind: "gh", login: given.login } : { kind: "reference", reference: given.reference };
    const read = await readCredential({ ...target, credential: source }, purpose);
    if (read.outcome === "unavailable") {
      if (source.kind === "reference") return { rejected: referenceRefused(source.reference.connectionId, read.refusal ?? "credential_source_unavailable", read.problem) };
      return { source, identity: null, problem: read.problem, held: null, aliases: unverified };
    }
    try {
      const heard = await heardWith(read.token);
      return heard.rejected !== undefined ? heard : { ...heard, source, held: null };
    } finally {
      read.release();
    }
  };

  /**
   * Asks `origins` about the credential the forge account holds, for an
   * update that names new aliases and no new credential: waiting unverified
   * when it cannot be read or has never answered.
   */
  const checkHeldAliases = async (account: ForgeAccountRecord, origins: readonly ForgeOrigin[]) => {
    if (origins.length === 0 || account.identity === null) return { aliases: origins.map((origin): ForgeAlias => ({ origin, verifiedAt: null })) };
    const read = await readCredential({ ...account, login: account.identity.login }, "update");
    if (read.outcome === "unavailable") return { aliases: origins.map((origin): ForgeAlias => ({ origin, verifiedAt: null })) };
    try {
      return await checkAliases(account.kind, read.token, account.identity, origins);
    } finally {
      read.release();
    }
  };

  /** Refuses `gh` and a client's `gh` for a forge account that is not GitHub's: `gh` holds GitHub tokens alone. */
  const refuseGhOffGitHub = (given: ForgeAddCredential | ImportedCredential, kind: ForgeKind): void => {
    if (kind === "github" || !(given.kind === "gh" || (given.kind === "stored" && given.provenance === "client-gh"))) return;
    const message = "gh holds GitHub tokens alone: give a Forgejo or Gitea forge account a pasted token or a key-manager reference.";
    throw new ContractError(invalidParams([{ code: "custom", path: ["credential"], message }], message));
  };

  /** The forge a URL in any form names, and the repository path it names there, if any; `invalid_params` for a URL that is no remote. */
  const remoteOf = (url: string) => {
    const remote = normaliseRemote(url);
    if (remote === null) {
      const message = "The URL names no forge: give its https or http address, an ssh or scp-like remote, or host:port.";
      throw new ContractError(invalidParams([{ code: "custom", path: ["url"], message }], message));
    }
    return remote;
  };

  /**
   * The forge a URL in any form names, and the repository path it names
   * there, if any; its kind as given, or GitHub for github.com, which alone
   * is known by its name. `invalid_params` otherwise.
   */
  const forgeOf = (url: string, given: ForgeKind | undefined) => {
    const remote = remoteOf(url);
    const kind = given ?? (remote.origin === GITHUB_ORIGIN ? "github" : undefined);
    if (kind === undefined) {
      const message = "Name the forge's kind (github, forgejo or gitea): only github.com is known by its name.";
      throw new ContractError(invalidParams([{ code: "custom", path: ["kind"], message }], message));
    }
    return { origin: remote.origin, kind, path: remote.path };
  };

  /** Why detection found no forge a forge account is added for at `origin`: GitLab's, none, or none that answered. */
  const undetected = (origin: ForgeOrigin, found: Exclude<Detection, { outcome: "detected" }>) =>
    found.outcome === "unreachable" ? ({ code: "unreachable", message: unreachableAtAdd(siteOf(origin)), data: { origin, details: [found.message] } } as const) : unreadable(origin, found);

  const add: ForgeAdd = {
    async prepare(params, context) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const given = params.credential;
      const formed = given.kind === "stored" ? arrive(forgeAccountId, given.token, context) : null;
      const { origin } = remoteOf(params.url);
      const aliases = aliasOrigins(params.aliases, origin) ?? [];
      const doomed = addRefusal(forgeAccountId, [origin, ...aliases], params.slug);
      if (doomed !== null) return rejecting<"forge.accounts.add">(doomed);
      // A kind not given is detected before the credential goes anywhere, so a token is never sent to an address of an unknown kind.
      const found: Detection = params.kind === undefined ? await detectForge(origin, providerOptions) : { outcome: "detected", kind: params.kind, version: null };
      if (found.outcome !== "detected") return rejecting<"forge.accounts.add">(undetected(origin, found));
      const { kind } = found;
      refuseGhOffGitHub(given, kind);

      const checked = await check<never>({ target: { id: forgeAccountId, origin, kind, login: null }, given, context, formed, purpose: "add", refuse: () => null, aliases });
      if (checked.rejected !== undefined) return rejecting<"forge.accounts.add">(checked.rejected);

      return (_params, command) => {
        // Read again in the transaction: another command may have taken the id, an origin or the slug meanwhile.
        const refused = addRefusal(forgeAccountId, [origin, ...aliases], params.slug);
        if (refused !== null) return { aggregate: stream, rejected: refused };
        const accounts = listForgeAccounts(reader);
        const slug = params.slug ?? deriveForgeSlug(origin, accounts.map((account) => account.slug));
        const current = primaryForgeAccount(reader);
        // The first forge account becomes primary (ADR 0012), whatever the call says; a later one only when asked.
        const primary = accounts.length === 0 || params.primary === true;
        const payload: ForgeAccountAddedPayload = {
          forgeAccountId,
          origin,
          aliases: [...checked.aliases],
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
        command.tx.afterCommit(() => {
          hold(forgeAccountId, checked.held);
          if (checked.source.kind !== "none") verifier.credentialGiven(forgeAccountId);
        });
        return { aggregate: stream, result: { account: recordOf(forgeAccountId) } };
      };
    },
  };

  /** Another user id than the forge account's, answered by its new credential. */
  const identityMismatch = (forgeAccountId: string, expected: ForgeIdentity, found: ForgeIdentity) =>
    ({
      code: "identity_mismatch",
      message: tokenOfOther(found.login, expected.login),
      data: { forgeAccountId, expected, found },
    }) as const;

  /** Why an update cannot go ahead as the store is now; null when it can. */
  const updateRefusal = (forgeAccountId: string, slug: string | undefined, found: ForgeIdentity | null, aliases: readonly ForgeOrigin[]): Refusal<"forge.accounts.update"> | null => {
    const current = liveForgeAccount(reader, forgeAccountId);
    if (current === null) return notFound(forgeAccountId);
    const taken = (slug === undefined ? null : slugTaken(slug, forgeAccountId)) ?? originHeld(aliases, forgeAccountId);
    if (taken !== null) return taken;
    if (found !== null && current.identity !== null && found.userId !== current.identity.userId) return identityMismatch(forgeAccountId, current.identity, found);
    return null;
  };

  /**
   * The aliases an update leaves, in the order given: one the forge account
   * has verified already keeps its verification; any other is as the
   * update's check found it.
   */
  const aliasesAfter = (current: ForgeAccountRecord, origins: readonly ForgeOrigin[], checked: readonly ForgeAlias[]): ForgeAlias[] =>
    origins.map(
      (origin) =>
        current.aliases.find((alias) => alias.origin === origin && alias.verifiedAt !== null) ??
        checked.find((alias) => alias.origin === origin) ?? { origin, verifiedAt: null },
    );

  const sameAliases = (one: readonly ForgeAlias[], other: readonly ForgeAlias[]): boolean => JSON.stringify(one) === JSON.stringify(other);

  const update: ForgeService["update"] = {
    async prepare(params, context) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const given = params.credential;
      const formed = given?.kind === "stored" ? arrive(forgeAccountId, given.token, context) : null;
      const doomed = updateRefusal(forgeAccountId, params.slug, null, []);
      if (doomed !== null) return rejecting<"forge.accounts.update">(doomed);
      const held = recordOf(forgeAccountId);
      const origins = aliasOrigins(params.aliases, held.origin);
      const aliasesHeld = origins === undefined ? null : originHeld(origins, forgeAccountId);
      if (aliasesHeld !== null) return rejecting<"forge.accounts.update">(aliasesHeld);
      // An alias the forge account has verified already keeps its verification; every other named is asked about.
      const toCheck = (origins ?? []).filter((origin) => !held.aliases.some((alias) => alias.origin === origin && alias.verifiedAt !== null));
      if (given !== undefined) refuseGhOffGitHub(given, held.kind);
      const checked =
        given === undefined
          ? await checkHeldAliases(held, toCheck)
          : await check({
              target: { id: forgeAccountId, origin: held.origin, kind: held.kind, login: held.identity?.login ?? null },
              given,
              context,
              formed,
              purpose: "update",
              refuse: (found) => updateRefusal(forgeAccountId, params.slug, found, []),
              aliases: toCheck,
            });
      if (checked.rejected !== undefined) return rejecting<"forge.accounts.update">(checked.rejected);
      const replacing = "source" in checked ? checked : null;
      const aliasesChecked = checked.aliases;

      return (_params, command) => {
        const found = replacing?.identity ?? null;
        const refused = updateRefusal(forgeAccountId, params.slug, found, origins ?? []);
        if (refused !== null) return { aggregate: stream, rejected: refused };
        const current = recordOf(forgeAccountId);
        const aliases = origins === undefined ? current.aliases : aliasesAfter(current, origins, aliasesChecked);
        const payload: ForgeAccountUpdatedPayload = { forgeAccountId };
        const changes: Partial<ForgeAccountUpdatedPayload> = {
          ...(params.slug !== undefined && params.slug !== current.slug && { slug: params.slug }),
          ...(!sameAliases(aliases, current.aliases) && { aliases }),
          // A problem of the kind it had holds since it began, as a verification keeps it.
          ...(replacing !== null && { credential: replacing.source, ...(found !== null && { identity: found }), problem: keepSince(current.problem, replacing.problem) }),
        };
        if (Object.keys(changes).length === 0) return { aggregate: stream, result: { account: current } };
        log.append(stream, [{ type: "forge.account.updated", payload: { ...payload, ...changes } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        if (replacing !== null) {
          command.tx.afterCommit(() => {
            hold(forgeAccountId, replacing.held);
            verifier.credentialGiven(forgeAccountId);
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
        entries.add(account.credential.entry);
        await holdStored(account);
      }
      try {
        for (const key of await vault.keys()) if (key.startsWith(VAULT_PREFIX) && !entries.has(key)) await vault.delete(key);
      } catch (error) {
        console.error("Deleting the vault entries of forge accounts that are gone failed; the next start tries again:", error);
      }
    },

    list: listSeen,

    referenceHolders(connectionId) {
      const id = connectionId.toLowerCase();
      return listForgeAccounts(reader)
        .filter((account) => account.credential.kind === "reference" && account.credential.reference.connectionId.toLowerCase() === id)
        .map((account) => ({ kind: "forge-account", id: account.id, name: account.origin }));
    },

    async resolveCredential(forgeAccountId, purpose) {
      const account = liveForgeAccount(reader, forgeAccountId.toLowerCase());
      if (account === null) return null;
      return readHeld(account, purpose);
    },

    probeGh: () => gh.probe(),

    startVerifying: () => verifier.start(),

    importTarget(origin) {
      return listForgeAccounts(reader).find((account) => account.origin === origin || account.aliases.some((alias) => alias.origin === origin && alias.verifiedAt !== null)) ?? null;
    },
    canImportOrigin(origin) {
      const holder = originHolder(reader, origin);
      if (holder === null) return true;
      const held = recordOf(holder);
      return held.origin === origin || held.aliases.some((alias) => alias.origin === origin && alias.verifiedAt !== null);
    },
    importRecord(params, command) {
      const { forgeAccountId, origin, kind, credential } = params;
      const existing = originHolder(reader, origin);
      if (existing !== null) {
        const held = recordOf(existing);
        if (held.origin !== origin && !held.aliases.some((alias) => alias.origin === origin && alias.verifiedAt !== null)) return { aggregate: stream, rejected: { code: "conflict", message: "The Forge owner has not verified this alias as the same identity." } };
        return { aggregate: stream, result: { targetId: existing, carried: false } };
      }
      const refused = addRefusal(forgeAccountId, [origin], undefined);
      if (refused !== null) return { aggregate: stream, rejected: refused };
      const accounts = listForgeAccounts(reader);
      const payload: ForgeAccountAddedPayload = {
        forgeAccountId, origin, kind, credential, aliases: [],
        slug: deriveForgeSlug(origin, accounts.map((account) => account.slug)),
        identity: null, primary: accounts.length === 0, clearedPrimary: null,
        problem: credential.kind === "none" ? needsCredential(origin) : problemNow("credential-unavailable", savedTokenUnreadable(siteOf(origin), true), ["A preserved key-manager reference, not yet read."]),
        copiedFrom: null,
      };
      log.append(stream, [{ type: "forge.account.added", payload }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { targetId: forgeAccountId, carried: true } };
    },

    async probeCredential(request) {
      const { origin, kind, path } = forgeOf(request.url, request.kind);
      // Held as a secret while it is asked about, never stored.
      const release = register("probe", request.token, kind, null);
      try {
        const found = await verifier.probe({ origin, kind, token: request.token, repository: path !== null && /^[^/]+\/[^/]+$/.test(path) ? path : null });
        return { origin, identity: found.identity, capabilities: found.capabilities, tokenInformation: found.tokenInformation, problem: found.problem };
      } finally {
        release();
      }
    },

    async detect(url) {
      const { origin } = remoteOf(url);
      const found = await detectForge(origin, providerOptions);
      if (found.outcome !== "detected") throw new ContractError(undetected(origin, found));
      return { origin, kind: found.kind, version: found.version, tokenPages: forgeTokenPages(found.kind, origin) };
    },

    async owners(forgeAccountId) {
      const id = forgeAccountId.toLowerCase();
      const account = liveForgeAccount(reader, id);
      if (account === null) throw new ContractError(notFound(id));
      const { origin } = account;
      const answer = await operations.repositories.owners({ origin, purpose: "list the owners a repository may be created under" });
      switch (answer.outcome) {
        case "done":
          return { owners: answer.value };
        case "failed": {
          const message = answer.status === 401 ? adviceLine(tokenRefused(siteOf(origin), account.identity?.login ?? null)) : cannotListOrganisations(siteOf(origin));
          throw new ContractError({ code: "verification_failed", message, data: { origin, status: answer.status, details: [answer.message] } });
        }
        case "unreachable":
          throw new ContractError({ code: "unreachable", message: adviceLine(notAnswering(siteOf(origin), answer.status)), data: { origin, details: [answer.message] } });
        case "refused":
          // Removed while it was asked: nothing serves its origin now.
          throw new ContractError(answer.error.code === "forge_account_missing" ? notFound(id) : answer.error);
      }
    },

    async verify(forgeAccountId) {
      const id = forgeAccountId?.toLowerCase();
      if (id !== undefined && liveForgeAccount(reader, id) === null) throw new ContractError(notFound(id));
      await Promise.all((id === undefined ? listForgeAccounts(reader).map((account) => account.id) : [id]).map(verifier.verify));
      return listSeen();
    },

    async verifiedWithin(maxAgeMs) {
      await Promise.all(listForgeAccounts(reader).map((account) => verifier.verifyStale(account.id, maxAgeMs)));
      return listSeen();
    },

    add,

    update,

    remove(params, context: CommandContext) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const current = liveForgeAccount(reader, forgeAccountId);
      if (current === null) return { aggregate: stream, rejected: notFound(forgeAccountId) };
      log.append(stream, [{ type: "forge.account.removed", payload: { forgeAccountId } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      context.tx.afterCommit(() => {
        hold(forgeAccountId, null);
        verifier.removed(forgeAccountId);
        if (current.credential.kind === "stored") deleteEntry(current.credential.entry);
      });
      return { aggregate: stream, result: { forgeAccountId } };
    },

    setPrimary(params, context: CommandContext) {
      const forgeAccountId = params.forgeAccountId.toLowerCase();
      const current = liveForgeAccount(reader, forgeAccountId);
      if (current === null) return { aggregate: stream, rejected: notFound(forgeAccountId) };
      if (current.primary) return { aggregate: stream, result: { account: verifier.seen(current) } };
      const cleared = primaryForgeAccount(reader);
      log.append(stream, [{ type: "forge.account.primary-set", payload: { forgeAccountId, cleared } }], { tx: context.tx, actor: context.actor, commandId: context.commandId });
      return { aggregate: stream, result: { account: recordOf(forgeAccountId) } };
    },

    ...operations,

    links,

    moveSource: createForgeMoveSource({ log, reader, vault, update }),

    processEnvironment:
      options.harnessCommand === undefined
        ? undefined
        : createForgeInjection({
            accounts: () => listForgeAccounts(reader),
            injected: isInjected,
            generations: () => credentialGenerations(reader),
            readCredential: readHeld,
            secrets,
            command: options.harnessCommand,
            address: options.address ?? (() => undefined),
          }),

    orientation: options.harnessCommand === undefined ? undefined : forgesSection(() => listForgeAccounts(reader)),

    secrets,

    git,

    missingOrigins: () => missing.counted(),

    gitRejected(forgeAccountId, origin) {
      const recorded = log.atomically((tx) => {
        if (liveForgeAccount(reader, forgeAccountId) === null) return false;
        log.append(stream, [{ type: "forge.account.git-rejected", payload: { forgeAccountId, origin } }], { tx, actor: FORGE_ACTOR });
        return true;
      });
      if (recorded) void verifier.verify(forgeAccountId);
    },

    close() {
      verifier.close();
      secrets.close();
      for (const release of held.values()) release();
      held.clear();
    },
  };
};

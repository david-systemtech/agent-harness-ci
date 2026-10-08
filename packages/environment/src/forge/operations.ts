import {
  ContractError,
  invalidParams,
  normaliseRemote,
  type CredentialUnavailableError,
  type ForgeAccountMissingError,
  type ForgeAccountRecord,
  type ForgeCapabilityName,
  type ForgeKind,
  type ForgeOrigin,
  type ForgeOwner,
  type KindUnsupportedError,
  type SecretShapedError,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import { secretShapedIn } from "../scrub/refusal.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import type { ForgeCredential } from "./forge-service.js";
import { kindUnsupported, type Detection } from "./detection.js";
import type { CallOptions } from "./forge-http.js";
import { listForgeAccounts, liveForgeAccount } from "./forge-store.js";
import { servingAccount } from "./git-helper.js";
import { adviceLine, belongsToOther, identityChangedLine, siteOf } from "./lines.js";
import { forgeAccountMissing } from "./missing-origins.js";
import type {
  DownloadedAsset,
  ForgeFile,
  ForgeValidateCheck,
  ForgeIssue,
  ForgeProvider,
  ForgePullRequest,
  ForgePullRequestReview,
  ForgeRelease,
  ForgeReleaseAsset,
  ForgeReply,
  ForgeRepository,
  ForgeRepositoryCapabilities,
  IssueContent,
  MergeMethod,
  PullRequestOpening,
} from "./providers.js";
import { FORGE_ACTOR, type Verifier } from "./verifier.js";

/**
 * The harness's operations on a forge (forge spec, "Providers"; ADR 0012,
 * ADR 0020; #316): the banks, skill sources, routines, the launcher and Set
 * up reach a forge through these and nothing else. Repositories read and
 * created, issues, pull requests, releases and their assets, and a file on a
 * branch, each through the provider of the forge's kind.
 *
 * - **Where.** An operation names a repository (`owner/name`) on an origin,
 *   in any form a remote takes, or on the primary forge when it names none.
 *   The forge account serving that origin (its canonical origin, a verified
 *   alias, or by host for an ssh form) is used, on its canonical origin.
 * - **No forge account.** A read on an origin none serves goes anonymously
 *   first, on the API of the kind the caller names, else of the kind
 *   detection finds (#470), kept for the process once found; the forge
 *   refusing it (401, 403, or a 404, behind which both APIs hide a private
 *   repository) is `forge_account_missing` and records the origin as
 *   missing (#314); the operation it names reading the repository it names
 *   anonymously later clears that record (#1891). Detection finding no forge, as for a
 *   forge walled to anonymous callers, reads on the Gitea API; a GitLab is refused
 *   `kind_unsupported`, not for want of a forge account; one detection
 *   cannot finish answers the read unreachable. A write there is refused
 *   `forge_account_missing` at once.
 * - **A credential per operation.** The forge account's credential is read
 *   for each operation and let go when it ends; one that cannot be read, or
 *   that answers as another user, is `credential_unavailable`.
 * - **Writes teach capabilities.** Every write first reads its target (the
 *   repository, the pull request, the organisation; the user's own, whose
 *   identity the verification reads), so a 404 after it is a refusal, not a
 *   target that is not there. A write that succeeds makes its capability
 *   `verified`; one refused with 401, 403 or 404 makes it `failed`; any
 *   other answer, or none, teaches nothing. A pull request read the forge
 *   denies (401, 403) fails `pullRequests` too. Each change of state is
 *   appended as `forge.account.capability-learned`, as `system:forge`, and
 *   only a change: a success on a capability already verified moves only
 *   when it was last verified.
 * - **Bodies are checked before they leave.** An issue's or a pull
 *   request's title or body holding a value the scrub registry holds, or a
 *   shape rule's hit, is refused `secret_shaped`, naming the rule and the
 *   field and never the value, and nothing reaches the forge.
 * - **Rate limits** an operation meets pause the forge account's
 *   scheduled verifications, as a verification's do.
 * - **Owners** (#313): the owners a repository may be created under, the
 *   forge account's user and then its organisations, read from the forge
 *   with its credential on every call and never kept (ADR 0020).
 */

/** Where an operation acts, and why. */
export interface ForgeTarget {
  /** The forge's origin, in any form a remote takes (a repository's URL, ssh or scp-like, `host:port`); absent, the primary forge's. */
  readonly origin?: string;
  /**
   * The kind of forge an origin no forge account serves is, for an
   * anonymous read; absent, detection finds it. A forge account's own kind
   * is used wherever one serves the origin.
   */
  readonly kind?: Exclude<ForgeKind, "gitlab">;
  /** What the operation is for, in a few words (`read the release channel`): a missing origin's record and the key-manager registry name it. */
  readonly purpose: string;
}

/** A repository an operation acts on. */
export interface RepositoryTarget extends ForgeTarget {
  /** `owner/name`. */
  readonly repository: string;
}

/** A pull request or an issue an operation acts on. */
export interface NumberedTarget extends RepositoryTarget {
  readonly number: number;
}

/** What creating a repository takes. */
export interface RepositoryCreationRequest extends ForgeTarget {
  /** The organisation it goes under; absent, or the forge account's own login, the user's own. */
  readonly organisation?: string;
  readonly name: string;
  readonly private: boolean;
  readonly description?: string;
}

/** An operation named no origin, and no forge account is primary. */
export interface NoPrimaryForgeRefusal {
  readonly code: "no_primary_forge";
  readonly message: string;
  readonly data: { readonly step: "forges" };
}

/** Why an operation did not reach the forge. */
export type ForgeRefusal = ForgeAccountMissingError | CredentialUnavailableError | SecretShapedError | NoPrimaryForgeRefusal | KindUnsupportedError;

/**
 * A refusal's cause, as a record that keeps one line of it says it: its details where it has them (the origin and the
 * forge's answer behind `forge_account_missing`'s plain line, #1850), else its line.
 */
export const refusalCause = (error: ForgeRefusal): string => {
  const details = "details" in error.data ? (error.data.details ?? []) : [];
  return details.length > 0 ? details.join(" ") : error.message;
};

/** What an operation came to: the forge's reply, or a refusal before it reached the forge. */
export type ForgeAnswer<T> = ForgeReply<T> | { readonly outcome: "refused"; readonly error: ForgeRefusal };

export interface ForgeOperations {
  readonly repositories: {
    /** Reads a repository: its visibility, default branch and web address. */
    get(request: RepositoryTarget): Promise<ForgeAnswer<ForgeRepository>>;
    /** This repository's read/push access with the account matched by origin. */
    capabilities(request: RepositoryTarget & { readonly signal?: AbortSignal }): Promise<ForgeAnswer<ForgeRepositoryCapabilities>>;
    /** Creates a repository, private or public, under the user or an organisation the forge account may create under (`createRepository`). */
    create(request: RepositoryCreationRequest): Promise<ForgeAnswer<ForgeRepository>>;
    /** Reads the content of the file at `path` on the branch `ref`. */
    file(request: RepositoryTarget & { readonly path: string; readonly ref: string }): Promise<ForgeAnswer<ForgeFile>>;
    /** The owners the forge account may create a repository under: its user, as the forge answers it now, then the organisations it is a member of. */
    owners(request: ForgeTarget): Promise<ForgeAnswer<ForgeOwner[]>>;
  };
  readonly users: {
    /** Reads the user `login` on the target's forge: done when the forge has one, a 404 when it has none (a team bank's owners, #1025). */
    get(request: ForgeTarget & { readonly login: string }): Promise<ForgeAnswer<null>>;
  };
  readonly issues: {
    get(request: NumberedTarget): Promise<ForgeAnswer<ForgeIssue>>;
    /** Opens an issue (`writeIssues`); its title and body pass the scrub registry's check first. */
    create(request: RepositoryTarget & IssueContent): Promise<ForgeAnswer<ForgeIssue>>;
  };
  readonly pullRequests: {
    /** The bank's validate check on one immutable pushed commit. */
    validateCheck(request: RepositoryTarget & { readonly sha: string; readonly signal?: AbortSignal }): Promise<ForgeAnswer<ForgeValidateCheck>>;
    get(request: NumberedTarget): Promise<ForgeAnswer<ForgePullRequest>>;
    reviews(request: NumberedTarget): Promise<ForgeAnswer<ForgePullRequestReview[]>>;
    /** Up to `limit` pull requests from the branch `branch` of `owner`'s repository (preset the target's owner), in every state, most recently updated first. */
    listByHead(request: RepositoryTarget & { readonly branch: string; readonly owner?: string; readonly limit: number }): Promise<ForgeAnswer<ForgePullRequest[]>>;
    /** Opens a pull request (`pullRequests`); its title and body pass the scrub registry's check first. */
    create(request: RepositoryTarget & PullRequestOpening): Promise<ForgeAnswer<ForgePullRequest>>;
    /** Merges a pull request (`pullRequests`) by `method`, preset a merge commit. */
    merge(request: NumberedTarget & { readonly method?: MergeMethod; readonly expectedHead?: string }): Promise<ForgeAnswer<null>>;
  };
  readonly releases: {
    /** Up to `limit` of the newest releases that are not drafts. */
    list(request: RepositoryTarget & { readonly limit: number }): Promise<ForgeAnswer<ForgeRelease[]>>;
    /** The release tagged `tag`; one that is a draft, or none, is a 404. */
    byTag(request: RepositoryTarget & { readonly tag: string }): Promise<ForgeAnswer<ForgeRelease>>;
    /** Downloads a release's asset into the file `destination`, answering its size and SHA-256; a download cut short leaves no file. */
    download(request: RepositoryTarget & { readonly asset: ForgeReleaseAsset; readonly destination: string; readonly signal?: AbortSignal }): Promise<ForgeAnswer<DownloadedAsset>>;
  };
}

export interface ForgeOperationsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly stream: StreamRef;
  readonly reader: Reader;
  readonly scrub: ScrubRegistry;
  readonly provider: (kind: ForgeKind) => ForgeProvider;
  /** Detects which forge an origin is, asking it with no credential, for an anonymous read that names no kind. */
  readonly detect: (origin: ForgeOrigin) => Promise<Detection>;
  /** Reads a forge account's credential for one operation. */
  readonly readCredential: (account: ForgeAccountRecord, purpose: string) => Promise<ForgeCredential>;
  readonly verifier: Pick<Verifier, "pause" | "used">;
  /** Records that `operation` was refused on `origin`, on `repository` where it names one, for want of a forge account. */
  readonly originMissing: (origin: ForgeOrigin, operation: string, repository?: string) => void;
  /** Hears that `operation` read `origin`'s `repository` anonymously, which clears a missing record naming both. */
  readonly originAnswered: (origin: ForgeOrigin, operation: string, repository: string) => void;
}

/** The repository a target names, `owner/name`; undefined for one that names none (a user, an owner list). */
const repositoryOf = (target: ForgeTarget): string | undefined => ("repository" in target && typeof target.repository === "string" ? target.repository : undefined);

/** The most organisations an owner list reads (a chosen default): more than anyone picks from. */
const MAX_OWNER_ORGANISATIONS = 100;

/** The statuses that refuse a write, or deny a pull-request read, as the capability's: a 404 counts for a write, whose target was just read. */
const REFUSING_WRITE: ReadonlySet<number> = new Set([401, 403, 404]);
const DENYING_READ: ReadonlySet<number> = new Set([401, 403]);

/** The statuses an anonymous read is refused with, which a forge account would answer: both APIs hide a private repository behind 404. */
const ASKS_FOR_A_CREDENTIAL: ReadonlySet<number> = new Set([401, 403, 404]);

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** An owner's or a repository's name as the forges allow one: letters, digits, `.`, `-` and `_`, never a dot segment, which a URL would resolve away. */
const NAME = "(?!\\.\\.?(?:/|$))[A-Za-z0-9._-]+";
const FULL_NAME = new RegExp(`^${NAME}/${NAME}$`);
const OWNER = new RegExp(`^${NAME}$`);

const invalid = (path: string, message: string): ContractError => new ContractError(invalidParams([{ code: "custom", path: [path], message }], message));

const fullNameOf = (repository: string): string => {
  if (!FULL_NAME.test(repository)) throw invalid("repository", "The repository is owner/name, each a name the forges allow.");
  return repository;
};

const organisationOf = (organisation: string | undefined): string | undefined => {
  if (organisation !== undefined && !OWNER.test(organisation)) throw invalid("organisation", "The organisation is a name the forges allow.");
  return organisation;
};

/** A file's path in a repository: segments that are neither empty nor a dot segment, so the request stays under the repository's contents. */
const filePathOf = (path: string): string => {
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw invalid("path", "The path names a file under the repository, with no empty or dot segment.");
  return path;
};

const numberOf = (number: number, name = "number"): number => {
  if (!Number.isSafeInteger(number) || number < 1) throw invalid(name, `The ${name} is a positive whole number.`);
  return number;
};

/** A request's asset, named by its id. */
const assetOf = (asset: ForgeReleaseAsset): ForgeReleaseAsset => {
  numberOf(asset.id, "asset's id");
  return asset;
};

/** How an operation reaches the forge: with the forge account serving the origin and its credential, or anonymously. */
interface Reached {
  /** The forge account; null for an anonymous read. */
  readonly account: ForgeAccountRecord | null;
  /** The canonical origin of the forge account, or the origin named. */
  readonly origin: ForgeOrigin;
  readonly provider: ForgeProvider;
  /** The credential's token; null anonymously. */
  readonly token: string | null;
  /** Rate limits a call meets, heard for the forge account. */
  readonly call: CallOptions;
}

/** A write's reach: a forge account's, with its token. */
type Writing = Reached & { readonly account: ForgeAccountRecord; readonly token: string };

const refused = (error: ForgeRefusal): { readonly outcome: "refused"; readonly error: ForgeRefusal } => ({ outcome: "refused", error });

export const createForgeOperations = (options: ForgeOperationsOptions): ForgeOperations => {
  const { log, clock, stream, reader, scrub, provider, verifier } = options;

  const noPrimary = (): NoPrimaryForgeRefusal => ({
    code: "no_primary_forge",
    message: "No forge is primary on this environment, and the operation named no origin: choose a primary forge in Set up, Forges.",
    data: { step: "forges" },
  });

  /** The forge account serving the target's origin, or the primary one when it names none; null for an origin none serves. */
  const locate = (target: ForgeTarget): { readonly origin: ForgeOrigin; readonly account: ForgeAccountRecord | null } | NoPrimaryForgeRefusal => {
    const accounts = listForgeAccounts(reader);
    if (target.origin === undefined) {
      const primary = accounts.find((account) => account.primary);
      return primary === undefined ? noPrimary() : { origin: primary.origin, account: primary };
    }
    const remote = normaliseRemote(target.origin);
    if (remote === null) throw invalid("origin", "The origin names no forge: give its https or http address, or a repository's remote.");
    const account = servingAccount(remote, accounts);
    return { origin: account?.origin ?? remote.origin, account };
  };

  /** Reads the forge account's credential for `work`, and lets it go when it ends; one that cannot be read, or answers as another user, is refused. */
  const withCredential = async <T>(account: ForgeAccountRecord, target: ForgeTarget, work: (reached: Writing) => Promise<ForgeAnswer<T>>): Promise<ForgeAnswer<T>> => {
    const { origin } = account;
    // A credential answering as another user is unused until it is replaced (forge spec, "Problem").
    if (account.problem?.kind === "identity-changed") {
      return refused({ code: "credential_unavailable", message: identityChangedLine(siteOf(origin), account.identity?.login ?? null, account.problem.message), data: { origin } });
    }
    const credential = await options.readCredential(account, target.purpose);
    if (credential.outcome === "unavailable") return refused({ code: "credential_unavailable", message: credential.problem.message, data: { origin } });
    try {
      return await work({ account, origin, provider: provider(account.kind), token: credential.token, call: { onPause: (until) => verifier.pause(account, until) } });
    } finally {
      credential.release();
    }
  };

  /**
   * Each origin's detection, asked or found: a kind found is kept for the
   * process, and an answer naming none is let go, so the next read asks
   * again rather than a passing fault refusing reads until a restart.
   */
  const detections = new Map<ForgeOrigin, Promise<Detection>>();

  /** Which forge `origin` is, detected once while reads ask at the same time and kept once found. */
  const detect = (origin: ForgeOrigin): Promise<Detection> => {
    const kept = detections.get(origin);
    if (kept !== undefined) return kept;
    const asked = options.detect(origin);
    detections.set(origin, asked);
    void asked.then(
      (found) => {
        if (found.outcome !== "detected") detections.delete(origin);
      },
      () => detections.delete(origin),
    );
    return asked;
  };

  /** Reaches the target's forge for a read: with the forge account serving it, else anonymously, where the forge refusing it is `forge_account_missing`. */
  const read = async <T>(target: ForgeTarget, work: (reached: Reached) => Promise<ForgeAnswer<T>>): Promise<ForgeAnswer<T>> => {
    const located = locate(target);
    if ("code" in located) return refused(located);
    const { origin, account } = located;
    if (account !== null) return withCredential(account, target, work);
    const found: Detection = target.kind === undefined ? await detect(origin) : { outcome: "detected", kind: target.kind, version: null };
    if (found.outcome === "unreachable") return { outcome: "unreachable", message: found.message };
    if (found.outcome === "unsupported") return refused(kindUnsupported(origin, found.kind));
    const kind = found.outcome === "detected" ? found.kind : "forgejo";
    const answer = await work({ account: null, origin, provider: provider(kind), token: null, call: {} });
    const repository = repositoryOf(target);
    if (answer.outcome === "done" && repository !== undefined) options.originAnswered(origin, target.purpose, repository);
    if (answer.outcome !== "failed" || !ASKS_FOR_A_CREDENTIAL.has(answer.status)) return answer;
    options.originMissing(origin, target.purpose, repository);
    return refused(forgeAccountMissing(origin, `it refused an anonymous read (HTTP ${answer.status})`));
  };

  /** Reaches the target's forge with the forge account serving it, which a write needs, and so does reading the account's own owners. */
  const withAccount = async <T>(target: ForgeTarget, work: (reached: Writing) => Promise<ForgeAnswer<T>>): Promise<ForgeAnswer<T>> => {
    const located = locate(target);
    if ("code" in located) return refused(located);
    const { origin, account } = located;
    if (account !== null) return withCredential(account, target, work);
    options.originMissing(origin, target.purpose, repositoryOf(target));
    return refused(forgeAccountMissing(origin, "a write needs one"));
  };

  /**
   * Records what `status` showed of the forge account's `capability`, when
   * it changed its state: nothing for a forge account removed or given
   * another credential meanwhile, whose findings are not its own now.
   */
  const learn = (account: ForgeAccountRecord, capability: ForgeCapabilityName, operation: string, status: number, refusing: ReadonlySet<number>): void => {
    const state = isSuccess(status) ? "verified" : refusing.has(status) ? "failed" : null;
    if (state === null) return;
    const current = log.atomically((tx) => {
      const now = liveForgeAccount(reader, account.id);
      if (now === null || JSON.stringify(now.credential) !== JSON.stringify(account.credential)) return false;
      if (now.capabilities[capability].state !== state) {
        log.append(stream, [{ type: "forge.account.capability-learned", payload: { forgeAccountId: account.id, capability, state, operation, status } }], { tx, actor: FORGE_ACTOR });
      }
      return true;
    });
    if (current && state === "verified") verifier.used(account.id, capability, clock.now().toISOString());
  };

  /** Learns from a write's answer, which a forge that did not answer teaches nothing. */
  const learnFrom = <T>(reached: Writing, capability: ForgeCapabilityName, operation: string, answer: ForgeAnswer<T>): ForgeAnswer<T> => {
    if (answer.outcome === "done" || answer.outcome === "failed") learn(reached.account, capability, operation, answer.status, REFUSING_WRITE);
    return answer;
  };

  /** A pull-request read's answer, whose denial fails `pullRequests` (GitHub's fine-grained permission covers both). */
  const readPullRequests = <T>(reached: Reached, operation: string, answer: ForgeAnswer<T>): ForgeAnswer<T> => {
    if (reached.account !== null && answer.outcome === "failed" && DENYING_READ.has(answer.status)) learn(reached.account, "pullRequests", operation, answer.status, DENYING_READ);
    return answer;
  };

  /** The first of `content`'s title and body holding a registered value or a shape rule's hit, refused `secret_shaped`; null when neither does. */
  const secretIn = (what: string, content: IssueContent): SecretShapedError | null =>
    secretShapedIn(scrub, what, { title: content.title, body: content.body }, "Nothing was sent to the forge.");

  return {
    repositories: {
      async capabilities(request) {
        const fullName = fullNameOf(request.repository);
        return read(request, ({ provider: forge, origin, token, call }) => forge.repositoryCapabilities(origin, token, fullName, { ...call, ...(request.signal !== undefined && { signal: request.signal }) }));
      },
      async get(request) {
        const fullName = fullNameOf(request.repository);
        return read(request, ({ provider: forge, origin, token, call }) => forge.repository(origin, token, fullName, call));
      },

      create: async (request) =>
        withAccount(request, async (reached) => {
          const { provider: forge, origin, token, call, account } = reached;
          const named = organisationOf(request.organisation);
          const organisation = named === undefined || named.toLowerCase() === account.identity?.login.toLowerCase() ? null : named;
          // The user's own is the identity the verification reads; an organisation is read first.
          if (organisation !== null) {
            const target = await forge.organisation(origin, token, organisation, call);
            if (target.outcome !== "done") return target;
          }
          const creation = { organisation, name: request.name, private: request.private, ...(request.description !== undefined && { description: request.description }) };
          return learnFrom(reached, "createRepository", "create a repository", await forge.createRepository(origin, token, creation, call));
        }),

      async file(request) {
        const fullName = fullNameOf(request.repository);
        const path = filePathOf(request.path);
        return read(request, ({ provider: forge, origin, token, call }) => forge.file(origin, token, fullName, path, request.ref, call));
      },

      owners: async (request) =>
        withAccount(request, async ({ provider: forge, origin, token, call, account }) => {
          const user = await forge.identity(origin, token, call);
          if (user.outcome === "unreachable") return user;
          if (user.outcome === "refused") return { outcome: "failed", status: user.status, message: user.message };
          // Another user's owners are not the forge account's: refused as a credential answering as another user is everywhere.
          const held = account.identity;
          if (held !== null && user.identity.userId !== held.userId) {
            return refused({ code: "credential_unavailable", message: adviceLine(belongsToOther(siteOf(origin), user.identity.login, held.login)), data: { origin } });
          }
          const organisations = await forge.organisations(origin, token, MAX_OWNER_ORGANISATIONS, call);
          if (organisations.outcome !== "done") return organisations;
          const owners: ForgeOwner[] = [{ login: user.identity.login, kind: "user" }, ...organisations.value.map((login): ForgeOwner => ({ login, kind: "organisation" }))];
          return { ...organisations, value: owners };
        }),
    },

    users: {
      get: async (request) => read(request, ({ provider: forge, origin, token, call }) => forge.user(origin, token, request.login, call)),
    },

    issues: {
      async get(request) {
        const [fullName, number] = [fullNameOf(request.repository), numberOf(request.number)];
        return read(request, ({ provider: forge, origin, token, call }) => forge.issue(origin, token, fullName, number, call));
      },

      async create(request) {
        const fullName = fullNameOf(request.repository);
        const secret = secretIn("issue", request);
        if (secret !== null) return refused(secret);
        return withAccount(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          const target = await forge.repository(origin, token, fullName, call);
          if (target.outcome !== "done") return target;
          return learnFrom(reached, "writeIssues", "create an issue", await forge.createIssue(origin, token, fullName, { title: request.title, body: request.body }, call));
        });
      },
    },

    pullRequests: {
      async reviews(request) {
        const [fullName, number] = [fullNameOf(request.repository), numberOf(request.number)];
        return read(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          return readPullRequests(reached, "read pull request reviews", await forge.pullRequestReviews(origin, token, fullName, number, call));
        });
      },
      async validateCheck(request) {
        const fullName = fullNameOf(request.repository);
        if (!/^[0-9a-f]{40,64}$/.test(request.sha)) throw invalid("sha", "The check names a full commit id.");
        return read(request, ({ provider: forge, origin, token, call }) => forge.validateCheck(origin, token, fullName, request.sha, { ...call, ...(request.signal && { signal: request.signal }) }));
      },
      async get(request) {
        const [fullName, number] = [fullNameOf(request.repository), numberOf(request.number)];
        return read(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          return readPullRequests(reached, "read a pull request", await forge.pullRequest(origin, token, fullName, number, call));
        });
      },

      async listByHead(request) {
        const fullName = fullNameOf(request.repository);
        const limit = numberOf(request.limit, "limit");
        const head = { owner: request.owner ?? fullName.slice(0, fullName.indexOf("/")), branch: request.branch };
        return read(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          return readPullRequests(reached, "list pull requests by head", await forge.pullRequestsByHead(origin, token, fullName, head, limit, call));
        });
      },

      async create(request) {
        const fullName = fullNameOf(request.repository);
        const secret = secretIn("pull request", request);
        if (secret !== null) return refused(secret);
        return withAccount(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          const target = await forge.repository(origin, token, fullName, call);
          if (target.outcome !== "done") return target;
          const opening = { title: request.title, body: request.body, head: request.head, base: request.base };
          return learnFrom(reached, "pullRequests", "open a pull request", await forge.createPullRequest(origin, token, fullName, opening, call));
        });
      },

      async merge(request) {
        const [fullName, number] = [fullNameOf(request.repository), numberOf(request.number)];
        return withAccount(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          const target = readPullRequests(reached, "read a pull request", await forge.pullRequest(origin, token, fullName, number, call));
          if (target.outcome !== "done") return target;
          return learnFrom(reached, "pullRequests", "merge a pull request", await forge.mergePullRequest(origin, token, fullName, number, request.method ?? "merge", call, request.expectedHead));
        });
      },
    },

    releases: {
      async list(request) {
        const fullName = fullNameOf(request.repository);
        const limit = numberOf(request.limit, "limit");
        return read(request, ({ provider: forge, origin, token, call }) => forge.releases(origin, token, fullName, limit, call));
      },

      async byTag(request) {
        const fullName = fullNameOf(request.repository);
        if (request.tag === "") throw invalid("tag", "The tag names a release.");
        return read(request, ({ provider: forge, origin, token, call }) => forge.release(origin, token, fullName, request.tag, call));
      },

      async download(request) {
        const fullName = fullNameOf(request.repository);
        const asset = assetOf(request.asset);
        return read(request, ({ provider: forge, origin, token, call }) =>
          forge.downloadAsset(origin, token, fullName, asset, request.destination, { ...call, ...(request.signal !== undefined && { signal: request.signal }) }),
        );
      },
    },
  };
};

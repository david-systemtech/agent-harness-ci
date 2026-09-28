import {
  ContractError,
  GITHUB_ORIGIN,
  invalidParams,
  normaliseRemote,
  type CredentialUnavailableError,
  type ForgeAccountMissingError,
  type ForgeAccountRecord,
  type ForgeCapabilityName,
  type ForgeKind,
  type ForgeOrigin,
} from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import type { ForgeCredential } from "./forge-service.js";
import type { CallOptions } from "./forge-http.js";
import { listForgeAccounts, liveForgeAccount } from "./forge-store.js";
import { servingAccount } from "./git-helper.js";
import { forgeAccountMissing } from "./missing-origins.js";
import type {
  DownloadedAsset,
  ForgeFile,
  ForgeIssue,
  ForgeProvider,
  ForgePullRequest,
  ForgeRelease,
  ForgeReleaseAsset,
  ForgeReply,
  ForgeRepository,
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
 *   first, on github.com's API for github.com and the Gitea API elsewhere
 *   unless the caller names the kind; the forge refusing it (401, 403, or a
 *   404, behind which both APIs hide a private repository) is
 *   `forge_account_missing` and records the origin as missing (#314). A
 *   write there is refused so at once.
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
 *   request's title or body holding a value the scrub registry holds is
 *   refused `secret_shaped`, naming the field and never the value, and
 *   nothing reaches the forge. The shape rules join this check with #363.
 * - **Rate limits** an operation meets pause the forge account's
 *   scheduled verifications, as a verification's do.
 */

/** Where an operation acts, and why. */
export interface ForgeTarget {
  /** The forge's origin, in any form a remote takes (a repository's URL, ssh or scp-like, `host:port`); absent, the primary forge's. */
  readonly origin?: string;
  /**
   * The kind of forge an origin no forge account serves is, for an
   * anonymous read: GitHub for github.com, else the Gitea API unless this
   * says `github` (an Enterprise origin). A forge account's own kind is used
   * wherever one serves the origin.
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

/** An issue's or a pull request's title or body held a value the environment holds as a secret: named by its field, never by the value. */
export interface SecretShapedRefusal {
  readonly code: "secret_shaped";
  readonly message: string;
  readonly data: { readonly field: "title" | "body" };
}

/** An operation named no origin, and no forge account is primary. */
export interface NoPrimaryForgeRefusal {
  readonly code: "no_primary_forge";
  readonly message: string;
  readonly data: { readonly step: "forges" };
}

/** Why an operation did not reach the forge. */
export type ForgeRefusal = ForgeAccountMissingError | CredentialUnavailableError | SecretShapedRefusal | NoPrimaryForgeRefusal;

/** What an operation came to: the forge's reply, or a refusal before it reached the forge. */
export type ForgeAnswer<T> = ForgeReply<T> | { readonly outcome: "refused"; readonly error: ForgeRefusal };

export interface ForgeOperations {
  readonly repositories: {
    /** Reads a repository: its visibility, default branch and web address. */
    get(request: RepositoryTarget): Promise<ForgeAnswer<ForgeRepository>>;
    /** Creates a repository, private or public, under the user or an organisation the forge account may create under (`createRepository`). */
    create(request: RepositoryCreationRequest): Promise<ForgeAnswer<ForgeRepository>>;
    /** Reads the content of the file at `path` on the branch `ref`. */
    file(request: RepositoryTarget & { readonly path: string; readonly ref: string }): Promise<ForgeAnswer<ForgeFile>>;
  };
  readonly issues: {
    get(request: NumberedTarget): Promise<ForgeAnswer<ForgeIssue>>;
    /** Opens an issue (`writeIssues`); its title and body pass the scrub registry first. */
    create(request: RepositoryTarget & IssueContent): Promise<ForgeAnswer<ForgeIssue>>;
  };
  readonly pullRequests: {
    get(request: NumberedTarget): Promise<ForgeAnswer<ForgePullRequest>>;
    /** Up to `limit` pull requests from the branch `branch` of `owner`'s repository (preset the target's owner), in every state, most recently updated first. */
    listByHead(request: RepositoryTarget & { readonly branch: string; readonly owner?: string; readonly limit: number }): Promise<ForgeAnswer<ForgePullRequest[]>>;
    /** Opens a pull request (`pullRequests`); its title and body pass the scrub registry first. */
    create(request: RepositoryTarget & PullRequestOpening): Promise<ForgeAnswer<ForgePullRequest>>;
    /** Merges a pull request (`pullRequests`) by `method`, preset a merge commit. */
    merge(request: NumberedTarget & { readonly method?: MergeMethod }): Promise<ForgeAnswer<null>>;
  };
  readonly releases: {
    /** Up to `limit` of the newest releases that are not drafts. */
    list(request: RepositoryTarget & { readonly limit: number }): Promise<ForgeAnswer<ForgeRelease[]>>;
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
  /** Reads a forge account's credential for one operation. */
  readonly readCredential: (account: ForgeAccountRecord, purpose: string) => Promise<ForgeCredential>;
  readonly verifier: Pick<Verifier, "pause" | "used">;
  /** Records that `operation` was refused on `origin` for want of a forge account. */
  readonly originMissing: (origin: ForgeOrigin, operation: string) => void;
}

/** The statuses that refuse a write, or deny a pull-request read, as the capability's: a 404 counts for a write, whose target was just read. */
const REFUSING_WRITE: ReadonlySet<number> = new Set([401, 403, 404]);
const DENYING_READ: ReadonlySet<number> = new Set([401, 403]);

/** The statuses an anonymous read is refused with, which a forge account would answer: both APIs hide a private repository behind 404. */
const ASKS_FOR_A_CREDENTIAL: ReadonlySet<number> = new Set([401, 403, 404]);

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** A repository's full name: two segments, neither empty nor holding a space. */
const FULL_NAME = /^[^/\s]+\/[^/\s]+$/;

const invalid = (path: string, message: string): ContractError => new ContractError(invalidParams([{ code: "custom", path: [path], message }], message));

const fullNameOf = (repository: string): string => {
  if (!FULL_NAME.test(repository)) throw invalid("repository", "The repository is owner/name.");
  return repository;
};

const numberOf = (number: number, name = "number"): number => {
  if (!Number.isSafeInteger(number) || number < 1) throw invalid(name, `The ${name} is a positive whole number.`);
  return number;
};

/** A request's asset, whose download address must be an http or https URL. */
const assetOf = (asset: ForgeReleaseAsset): ForgeReleaseAsset => {
  numberOf(asset.id, "asset's id");
  const url = URL.parse(asset.downloadUrl);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) throw invalid("asset", "The asset's download address is an http or https URL.");
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
    if (account.problem?.kind === "identity-changed") return refused({ code: "credential_unavailable", message: account.problem.message, data: { origin } });
    const credential = await options.readCredential(account, target.purpose);
    if (credential.outcome === "unavailable") return refused({ code: "credential_unavailable", message: credential.problem.message, data: { origin } });
    try {
      return await work({ account, origin, provider: provider(account.kind), token: credential.token, call: { onPause: (until) => verifier.pause(account, until) } });
    } finally {
      credential.release();
    }
  };

  /** Reaches the target's forge for a read: with the forge account serving it, else anonymously, where the forge refusing it is `forge_account_missing`. */
  const read = async <T>(target: ForgeTarget, work: (reached: Reached) => Promise<ForgeAnswer<T>>): Promise<ForgeAnswer<T>> => {
    const located = locate(target);
    if ("code" in located) return refused(located);
    const { origin, account } = located;
    if (account !== null) return withCredential(account, target, work);
    const kind = target.kind ?? (origin === GITHUB_ORIGIN ? "github" : "forgejo");
    const answer = await work({ account: null, origin, provider: provider(kind), token: null, call: {} });
    if (answer.outcome !== "failed" || !ASKS_FOR_A_CREDENTIAL.has(answer.status)) return answer;
    options.originMissing(origin, target.purpose);
    return refused(forgeAccountMissing(origin, `it refused an anonymous read (HTTP ${answer.status})`));
  };

  /** Reaches the target's forge for a write, which needs the forge account serving it. */
  const write = async <T>(target: ForgeTarget, work: (reached: Writing) => Promise<ForgeAnswer<T>>): Promise<ForgeAnswer<T>> => {
    const located = locate(target);
    if ("code" in located) return refused(located);
    const { origin, account } = located;
    if (account !== null) return withCredential(account, target, work);
    options.originMissing(origin, target.purpose);
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

  /** The first of `content`'s fields holding a value the scrub registry holds, refused `secret_shaped`; null when neither does. */
  const secretIn = (what: string, content: IssueContent): SecretShapedRefusal | null => {
    for (const field of ["title", "body"] as const) {
      if (scrub.scrub(content[field]) !== content[field]) {
        return { code: "secret_shaped", message: `The ${what}'s ${field} holds a secret this environment holds: take it out. Nothing was sent to the forge.`, data: { field } };
      }
    }
    return null;
  };

  return {
    repositories: {
      async get(request) {
        const fullName = fullNameOf(request.repository);
        return read(request, ({ provider: forge, origin, token, call }) => forge.repository(origin, token, fullName, call));
      },

      create: async (request) =>
        write(request, async (reached) => {
          const { provider: forge, origin, token, call, account } = reached;
          const named = request.organisation;
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
        return read(request, ({ provider: forge, origin, token, call }) => forge.file(origin, token, fullName, request.path, request.ref, call));
      },
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
        return write(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          const target = await forge.repository(origin, token, fullName, call);
          if (target.outcome !== "done") return target;
          return learnFrom(reached, "writeIssues", "create an issue", await forge.createIssue(origin, token, fullName, { title: request.title, body: request.body }, call));
        });
      },
    },

    pullRequests: {
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
        return write(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          const target = await forge.repository(origin, token, fullName, call);
          if (target.outcome !== "done") return target;
          const opening = { title: request.title, body: request.body, head: request.head, base: request.base };
          return learnFrom(reached, "pullRequests", "open a pull request", await forge.createPullRequest(origin, token, fullName, opening, call));
        });
      },

      async merge(request) {
        const [fullName, number] = [fullNameOf(request.repository), numberOf(request.number)];
        return write(request, async (reached) => {
          const { provider: forge, origin, token, call } = reached;
          const target = readPullRequests(reached, "read a pull request", await forge.pullRequest(origin, token, fullName, number, call));
          if (target.outcome !== "done") return target;
          return learnFrom(reached, "pullRequests", "merge a pull request", await forge.mergePullRequest(origin, token, fullName, number, request.method ?? "merge", call));
        });
      },
    },

    releases: {
      async list(request) {
        const fullName = fullNameOf(request.repository);
        const limit = numberOf(request.limit, "limit");
        return read(request, ({ provider: forge, origin, token, call }) => forge.releases(origin, token, fullName, limit, call));
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

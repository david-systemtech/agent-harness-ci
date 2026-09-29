import {
  GITHUB_ORIGIN,
  normaliseRemote,
  parsePullRequestUrl,
  pullRequestUrl,
  type ErrorOf,
  type ForgeAccountRecord,
  type ForgeKind,
  type ForgeOrigin,
  type PullRequest,
  type PullRequestReference,
} from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { CommandRejection, PreparedCommand } from "../serve/methods.js";
import { sessionNotFound } from "../sessions/decider.js";
import { readSummary } from "../sessions/session-reads.js";
import type { Reader } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";
import { servingAccount } from "./git-helper.js";
import type { ForgeAnswer, ForgeOperations } from "./operations.js";
import type { ForgePullRequest } from "./providers.js";

/**
 * A session's pull requests (forge spec, "Pull-request links and status";
 * ADR 0012; #317): linked by a person, found at a run's end, and kept
 * current, so session-state's settle sweep has a `mergedAt` to read. The
 * events and the summary's `pullRequests` are session-state's (#117); this
 * module appends them.
 *
 * - **Where a pull request is.** A URL is read by the provider of the forge
 *   account serving its origin, else GitHub's on github.com, else whichever
 *   reads it (GitHub's `/pull/`, the Gitea API's `/pulls/`). A session keeps
 *   a pull request by its web URL on the origin it is read from (the forge
 *   account's canonical origin), its owner and repository as the forge
 *   spells them, whatever page or alias the URL named.
 */

/** A pull request a URL names, and where it is read. */
interface Located {
  /** The kind of the provider that reads it: the forge account's, or the one whose shape the URL has. */
  readonly kind: Exclude<ForgeKind, "gitlab">;
  readonly reference: PullRequestReference;
  /** The origin it is read on: the canonical origin of the forge account serving the URL's, else the URL's own. */
  readonly origin: ForgeOrigin;
  /** The forge account serving it; null where none does, so it is read anonymously. */
  readonly account: ForgeAccountRecord | null;
}

export interface PullRequestLinksOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The log's query-only read: inside a command it reads that command's own transaction. */
  readonly reader: Reader;
  /** The forge accounts as the environment holds them now. */
  readonly accounts: () => readonly ForgeAccountRecord[];
  /** The ForgeService's pull-request operations, which read with the forge account serving an origin, or anonymously. */
  readonly pullRequests: ForgeOperations["pullRequests"];
}

export interface PullRequestLinks {
  /** `forge.pullRequests.link`: reads the pull request, then links it as the client session. */
  readonly link: PreparedCommand<"forge.pullRequests.link">;
}

type LinkRefusal = CommandRejection<ErrorOf<"forge.pullRequests.link">["code"]>;

/** The kinds whose shape a URL on an origin no forge account serves is tried with: GitHub Enterprise's, then the Gitea API's. */
const ANONYMOUS_KINDS: readonly Exclude<ForgeKind, "gitlab">[] = ["github", "forgejo"];

export const createPullRequestLinks = (options: PullRequestLinksOptions): PullRequestLinks => {
  const { log, reader } = options;

  /** Where the pull request `url` names is read; null for a URL no provider reads as one. */
  const locate = (url: string): Located | null => {
    const remote = normaliseRemote(url);
    const account = remote === null ? null : servingAccount(remote, options.accounts());
    const kinds = account !== null ? (account.kind === "gitlab" ? [] : [account.kind]) : remote?.origin === GITHUB_ORIGIN ? (["github"] as const) : ANONYMOUS_KINDS;
    for (const kind of kinds) {
      const reference = parsePullRequestUrl(kind, url);
      if (reference !== null) return { kind, reference, origin: account?.origin ?? reference.origin, account };
    }
    return null;
  };

  /**
   * What tells one pull request from another, however a URL spells it: its
   * number in its repository on the origin it is read on, the names in
   * lower case as the forges read them; a URL no provider reads is itself.
   */
  const keyOf = (url: string): string => {
    const located = locate(url);
    if (located === null) return url;
    const { owner, repository, number } = located.reference;
    return [located.origin, owner.toLowerCase(), repository.toLowerCase(), number].join("\n");
  };

  /** The session's pull request `url` names, as it holds it; undefined for none. */
  const heldIn = (pullRequests: readonly PullRequest[], url: string): PullRequest | undefined => {
    const key = keyOf(url);
    return pullRequests.find((held) => keyOf(held.url) === key);
  };

  /** Whether two readings of a pull request say the same. */
  const same = (one: PullRequest, other: PullRequest): boolean => one.state === other.state && one.mergedAt === other.mergedAt && one.closedAt === other.closedAt;

  /** The pull request as the session keeps it: on the origin it was read on, its owner and repository as the forge's own page spells them. */
  const kept = (located: Located, read: ForgePullRequest): PullRequest => {
    const spelled = parsePullRequestUrl(located.kind, read.url) ?? located.reference;
    const url = pullRequestUrl(located.kind, { origin: located.origin, owner: spelled.owner, repository: spelled.repository, number: located.reference.number });
    if (url === null) throw new Error(`No web URL of a pull request on a ${located.kind} forge.`);
    return { url, state: read.state, mergedAt: read.mergedAt, closedAt: read.closedAt };
  };

  /** Reads the pull request `located` names, as `purpose` says. */
  const read = (located: Located, purpose: string): Promise<ForgeAnswer<ForgePullRequest>> => {
    const { reference } = located;
    return options.pullRequests.get({ origin: located.origin, kind: located.kind, repository: `${reference.owner}/${reference.repository}`, number: reference.number, purpose });
  };

  /** Why a link's read linked nothing, as the method's refusal. */
  const unread = (located: Located, answer: Exclude<ForgeAnswer<ForgePullRequest>, { outcome: "done" }>): LinkRefusal => {
    const { origin } = located;
    switch (answer.outcome) {
      case "refused": {
        const { error } = answer;
        if (error.code === "forge_account_missing" || error.code === "credential_unavailable") return error;
        // A read names its origin and sends no body, so neither the primary forge nor the scrub can refuse it.
        throw new Error(`Reading a pull request was refused ${error.code}: ${error.message}`);
      }
      case "unreachable":
        return { code: "unreachable", message: answer.message, data: { origin } };
      case "failed": {
        if (answer.status !== 404) return { code: "verification_failed", message: `${answer.message} Nothing was linked.`, data: { origin, status: answer.status } };
        const url = pullRequestUrl(located.kind, { ...located.reference, origin }) ?? origin;
        return { code: "not_found", message: `The forge at ${origin} has no pull request ${url}.`, data: { kind: "pull_request", url } };
      }
    }
  };

  const notAPullRequest = (url: string): LinkRefusal => {
    const origin = normaliseRemote(url)?.origin ?? null;
    return {
      code: "not_a_pull_request",
      message: `The URL is no pull request's page on ${origin ?? "a forge"}: give its /pull/<number> page on GitHub, or its /pulls/<number> page on Forgejo or Gitea.`,
      data: { origin },
    };
  };

  const link: PullRequestLinks["link"] = {
    async prepare(params) {
      const stream = sessionStream(params.sessionId);
      const rejecting = (rejected: LinkRefusal) => () => ({ aggregate: stream, rejected });
      if (readSummary(reader, params.sessionId) === null) return rejecting(sessionNotFound(params.sessionId));
      const located = locate(params.url);
      if (located === null) return rejecting(notAPullRequest(params.url));
      const answer = await read(located, "link a pull request to a session");
      if (answer.outcome !== "done") return rejecting(unread(located, answer));
      const pullRequest = kept(located, answer.value);

      return (_params, command) => {
        const current = readSummary(reader, params.sessionId);
        if (current === null) return { aggregate: stream, rejected: sessionNotFound(params.sessionId) };
        const held = heldIn(current.pullRequests, pullRequest.url);
        // One linked already keeps the URL it was linked by; as the forge answers it now, there is nothing to link.
        if (held !== undefined && same(held, pullRequest)) return { aggregate: stream, result: { summary: current } };
        const payload: PullRequest = { ...pullRequest, url: held?.url ?? pullRequest.url };
        log.append(stream, [{ type: "session.pull-request-linked", payload: { ...payload } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        const summary = readSummary(reader, params.sessionId);
        if (summary === null) throw new Error(`The session ${params.sessionId} is not in the list after a pull request was linked to it.`);
        return { aggregate: stream, result: { summary } };
      };
    },
  };

  return { link };
};

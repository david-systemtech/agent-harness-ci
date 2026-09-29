import { EnvironmentNotice, type EventEnvelope, type ForgeAccountRecord, type ForgeCapabilityName, type ForgeProblem, type ForgeProblemKind } from "@agent-harness/contracts";
import type { NoticeInput, Notices, StepAction } from "../notices.js";

/**
 * The forge's rows in `projections.notices` (forge spec, "Events"; ADR
 * 0020; #320): a failed capability, a new problem, a git rejection and a
 * missing origin each raise one, naming the environment and the forge
 * origin, and offering the Forges step on that environment. Only news
 * raises one; heard as history (a replay onto a stream that held nothing),
 * an event raises none, but is still read for what it says of the forge
 * accounts:
 *
 * - **A failed capability** is `forge.account.capability-learned` with state
 *   `failed`: an operation's refusal (ADR 0020, "failed, with a notice"). A
 *   read probed at verification is the Forges step's `forges.reads` check.
 * - **A new problem** is a problem on `forge.account.added`, on
 *   `forge.account.updated` (a credential replaced) or on
 *   `forge.account.verified` whose kind differs from the kind this runtime
 *   last heard for that forge account, none heard counting as another: the
 *   environment keeps a problem of the kind there was, since-time and all,
 *   and records a verification that changed something else beside it.
 * - **A git rejection** is `forge.account.git-rejected`, naming the origin
 *   git was refused on; **a missing origin** is `forge.origin-missing`,
 *   which the environment records at most daily per origin.
 *
 * Only the add names a forge account's origin, so the origins heard are
 * kept per environment, and the request cache's `forge.accounts.list` is
 * read beside them; one known to neither (its add was before the stream's
 * cursor) is read from the environment with `forge.accounts.list`, and the
 * row is raised once it answers, rows behind it waiting their turn so they
 * keep the order they were heard in. An origin never changes, so a list
 * read at any time names it.
 */

/** What a forge notice offers: the Forges step on its environment. */
export const FORGE_NOTICE_ACTION: StepAction = "setup.forges";

/** What a forge account cannot do when a capability has failed, as a notice says it. */
const CANNOT: Readonly<Record<ForgeCapabilityName, string>> = {
  readRepository: "read repositories",
  writeIssues: "write issues",
  pullRequests: "work with pull requests",
  createRepository: "create repositories",
  readReleases: "read releases",
};

export interface ForgeNoticesHost {
  readonly notices: Notices;
  /** The environment's name now, as its record has it. */
  readonly name: (environmentId: string) => string;
  /** The forge accounts the request cache holds for the environment, if it holds them; never fetches. */
  readonly held: (environmentId: string) => readonly ForgeAccountRecord[] | null;
  /** Reads the environment's forge accounts now; null when it could not. */
  readonly list: (environmentId: string) => Promise<readonly ForgeAccountRecord[] | null>;
  readonly report: (error: unknown) => void;
}

export interface ForgeNotices {
  /** Reads a forge event on the environment's stream, and raises what it says when it is `news`. */
  heard(environmentId: string, event: EventEnvelope, news: boolean): void;
  /** Lets go of what is known of an environment's forge accounts: it was removed. A row waiting for its origin is raised no more. */
  forget(environmentId: string): void;
  close(): void;
}

/** A row still to raise: its words, once the forge account's origin is known (null when it could not be). */
interface Waiting {
  readonly forgeAccountId: string | null;
  readonly words: (origin: string | null) => string;
}

/** What is known of one environment's forge accounts. */
interface Known {
  readonly origins: Map<string, string>;
  /** Each forge account's problem kind as last heard; null for none. A forge account never heard of is not here. */
  readonly problems: Map<string, ForgeProblemKind | null>;
  /** Rows waiting behind a forge account's origin, in the order they were heard. */
  readonly waiting: Waiting[];
  looking: boolean;
}

export const createForgeNotices = (host: ForgeNoticesHost): ForgeNotices => {
  const known = new Map<string, Known>();
  let closed = false;

  const knownOf = (environmentId: string): Known => {
    let state = known.get(environmentId);
    if (state === undefined) known.set(environmentId, (state = { origins: new Map(), problems: new Map(), waiting: [], looking: false }));
    return state;
  };

  const originOf = (environmentId: string, state: Known, forgeAccountId: string): string | null =>
    state.origins.get(forgeAccountId) ?? host.held(environmentId)?.find((account) => account.id === forgeAccountId)?.origin ?? null;

  const raise = (environmentId: string, message: string): void => {
    const draft: NoticeInput = { kind: "forge", message, action: FORGE_NOTICE_ACTION };
    host.notices.raise(environmentId, draft);
  };

  /** Raises every waiting row whose origin is known, in order, and looks the next unknown one up. */
  const drain = (environmentId: string, state: Known, lookedUp: boolean): void => {
    while (state.waiting.length > 0) {
      const [next] = state.waiting as [Waiting];
      const origin = next.forgeAccountId === null ? null : originOf(environmentId, state, next.forgeAccountId);
      if (origin === null && next.forgeAccountId !== null && !lookedUp) return lookUp(environmentId, state);
      state.waiting.shift();
      raise(environmentId, next.words(origin));
    }
  };

  const lookUp = (environmentId: string, state: Known): void => {
    if (state.looking) return;
    state.looking = true;
    void host
      .list(environmentId)
      .catch((error: unknown) => {
        host.report(error);
        return null;
      })
      .then((accounts) => {
        state.looking = false;
        if (closed || known.get(environmentId) !== state) return;
        for (const account of accounts ?? []) if (!state.origins.has(account.id)) state.origins.set(account.id, account.origin);
        // What the list did not name (a forge account removed meanwhile, or no answer) is said without its origin.
        drain(environmentId, state, true);
      });
  };

  /** Says `words` of a forge account once its origin is known. */
  const say = (environmentId: string, state: Known, forgeAccountId: string, words: (origin: string | null) => string): void => {
    state.waiting.push({ forgeAccountId, words });
    drain(environmentId, state, false);
  };

  /** Notes a forge account's problem as heard, and says it when it is news and of another kind than the one heard before. */
  const problemHeard = (environmentId: string, state: Known, forgeAccountId: string, problem: ForgeProblem | null, news: boolean): void => {
    const before = state.problems.has(forgeAccountId) ? state.problems.get(forgeAccountId) : undefined;
    state.problems.set(forgeAccountId, problem?.kind ?? null);
    if (!news || problem === null || before === problem.kind) return;
    say(environmentId, state, forgeAccountId, (origin) => `${origin ?? "A forge account"} on ${host.name(environmentId)}: ${problem.message}`);
  };

  return {
    heard(environmentId, event, news) {
      if (closed || !event.type.startsWith("forge.")) return;
      const parsed = EnvironmentNotice.safeParse(event);
      if (!parsed.success) return;
      const notice = parsed.data;
      const state = knownOf(environmentId);
      const name = () => host.name(environmentId);
      switch (notice.type) {
        case "forge.account.added": {
          const { forgeAccountId, origin, problem } = notice.payload;
          state.origins.set(forgeAccountId, origin);
          return problemHeard(environmentId, state, forgeAccountId, problem, news);
        }
        case "forge.account.updated":
        case "forge.account.verified": {
          const { forgeAccountId, problem } = notice.payload;
          // An update names a problem only when it replaced the credential.
          if (problem !== undefined) problemHeard(environmentId, state, forgeAccountId, problem, news);
          return;
        }
        case "forge.account.capability-learned": {
          const { forgeAccountId, capability, state: learned, operation, status } = notice.payload;
          if (!news || learned !== "failed") return;
          const refused = status === null ? "" : ` (${status})`;
          return say(
            environmentId,
            state,
            forgeAccountId,
            (origin) =>
              `${origin ?? "A forge"} on ${name()} refused to ${operation}${refused}: its forge account cannot ${CANNOT[capability]}; give it a credential that can in Set up, Forges.`,
          );
        }
        case "forge.account.git-rejected": {
          if (!news) return;
          const { origin } = notice.payload;
          state.waiting.push({ forgeAccountId: null, words: () => `git on ${name()} was refused on ${origin} with the forge account's credential, which ${name()} is verifying again.` });
          return drain(environmentId, state, false);
        }
        case "forge.origin-missing": {
          if (!news) return;
          const { origin, operation } = notice.payload;
          state.waiting.push({
            forgeAccountId: null,
            words: () => `${name()} was refused on ${origin} when it tried to ${operation}: no forge account covers it; add one in Set up, Forges.`,
          });
          return drain(environmentId, state, false);
        }
        // A removal and a new primary say nothing that needs attention; an id is never used again, so what is known of a removed
        // forge account is kept, for a row still waiting behind its origin.
        default:
          return;
      }
    },
    forget(environmentId) {
      known.delete(environmentId);
    },
    close() {
      closed = true;
      known.clear();
    },
  };
};

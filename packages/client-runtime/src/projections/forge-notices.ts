import { EnvironmentNotice, type EventEnvelope, type ForgeAccountRecord, type ForgeCapabilityName, type ForgeProblem, type ForgeProblemKind } from "@agent-harness/contracts";
import type { NoticeInput, Notices, StepAction } from "../notices.js";
import { createNamedRows } from "./named-rows.js";

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
 *   which the environment records at most daily per origin. Its rows are
 *   withdrawn by `forge.origin-answered` for the same origin and operation:
 *   the operation read the origin anonymously after all (#1891).
 *
 * A row names its forge account by its origin, which only the add names:
 * the origins heard are kept per environment beside the request cache's
 * `forge.accounts.list`, and one known to neither (its add was before the
 * stream's cursor) is read with `forge.accounts.list` once the connection
 * is ready, the rows behind it waiting their turn so they keep the order
 * they were heard in (`named-rows.ts`). An origin never changes, so a list
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
  /** Reads the environment's forge accounts once its connection is ready; null when it could not. */
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

export const createForgeNotices = (host: ForgeNoticesHost): ForgeNotices => {
  /** Each forge account's problem kind as last heard, per environment; null for none. A forge account never heard of is not here. */
  const problems = new Map<string, Map<string, ForgeProblemKind | null>>();
  /** The ids of the rows raised for each missing origin's operation (`missingKey`), per environment, which its answer withdraws. */
  const missing = new Map<string, Map<string, string[]>>();
  let closed = false;
  // A forge account is known by its origin, which only its add names, and which never changes, so a list read at any time names it.
  const rows = createNamedRows({
    notices: host.notices,
    draft: (message): NoticeInput => ({ kind: "forge", message, action: FORGE_NOTICE_ACTION }),
    held: (environmentId, forgeAccountId) => host.held(environmentId)?.find((account) => account.id === forgeAccountId)?.origin ?? null,
    list: async (environmentId) => {
      const accounts = await host.list(environmentId);
      return accounts === null ? null : new Map(accounts.map((account) => [account.id, account.origin]));
    },
    report: host.report,
  });

  const missingKey = (origin: string, operation: string): string => `${origin} ${operation}`;

  const missingOf = (environmentId: string): Map<string, string[]> => {
    let held = missing.get(environmentId);
    if (held === undefined) missing.set(environmentId, (held = new Map()));
    return held;
  };

  const problemsOf = (environmentId: string): Map<string, ForgeProblemKind | null> => {
    let held = problems.get(environmentId);
    if (held === undefined) problems.set(environmentId, (held = new Map()));
    return held;
  };

  /** Notes a forge account's problem as heard, and says it when it is news and of another kind than the one heard before. */
  const problemHeard = (environmentId: string, forgeAccountId: string, problem: ForgeProblem | null, news: boolean): void => {
    const heard = problemsOf(environmentId);
    const before = heard.has(forgeAccountId) ? heard.get(forgeAccountId) : undefined;
    heard.set(forgeAccountId, problem?.kind ?? null);
    if (!news || problem === null || before === problem.kind) return;
    rows.say(environmentId, forgeAccountId, (origin) => `${origin ?? "A forge account"} on ${host.name(environmentId)}: ${problem.message}`);
  };

  return {
    heard(environmentId, event, news) {
      if (closed || !event.type.startsWith("forge.")) return;
      const parsed = EnvironmentNotice.safeParse(event);
      if (!parsed.success) return;
      const notice = parsed.data;
      const name = () => host.name(environmentId);
      switch (notice.type) {
        case "forge.account.added": {
          const { forgeAccountId, origin, problem } = notice.payload;
          rows.named(environmentId, forgeAccountId, origin);
          return problemHeard(environmentId, forgeAccountId, problem, news);
        }
        case "forge.account.updated":
        case "forge.account.verified": {
          const { forgeAccountId, problem } = notice.payload;
          // An update names a problem only when it replaced the credential.
          if (problem !== undefined) problemHeard(environmentId, forgeAccountId, problem, news);
          return;
        }
        case "forge.account.capability-learned": {
          const { forgeAccountId, capability, state: learned, operation, status } = notice.payload;
          if (!news || learned !== "failed") return;
          const refused = status === null ? "" : ` (${status})`;
          return rows.say(
            environmentId,
            forgeAccountId,
            (origin) =>
              `${origin ?? "A forge"} on ${name()} refused to ${operation}${refused}: its forge account cannot ${CANNOT[capability]}; give it a credential that can in Set up, Forges.`,
          );
        }
        case "forge.account.git-rejected": {
          if (!news) return;
          const { origin } = notice.payload;
          return rows.say(environmentId, null, () => `git on ${name()} was refused on ${origin} with the forge account's credential, which ${name()} is verifying again.`);
        }
        case "forge.origin-missing": {
          if (!news) return;
          const { origin, operation } = notice.payload;
          const key = missingKey(origin, operation);
          return rows.say(
            environmentId,
            null,
            () => `${name()} was refused on ${origin} when it tried to ${operation}: no forge account covers it; add one in Set up, Forges.`,
            (raised) => {
              const held = missingOf(environmentId);
              held.set(key, [...(held.get(key) ?? []), raised.id]);
            },
          );
        }
        // Heard as history too: it withdraws only a row this runtime raised, and history raises none.
        case "forge.origin-answered": {
          const key = missingKey(notice.payload.origin, notice.payload.operation);
          return rows.inTurn(environmentId, () => {
            const ids = missing.get(environmentId)?.get(key);
            if (ids === undefined) return;
            missing.get(environmentId)?.delete(key);
            host.notices.retire((raised) => ids.includes(raised.id));
          });
        }
        // A removal and a new primary say nothing that needs attention; an id is never used again, so what is known of a removed
        // forge account is kept, for a row still waiting behind its origin.
        default:
          return;
      }
    },
    forget(environmentId) {
      problems.delete(environmentId);
      missing.delete(environmentId);
      rows.forget(environmentId);
    },
    close() {
      closed = true;
      problems.clear();
      missing.clear();
      rows.close();
    },
  };
};

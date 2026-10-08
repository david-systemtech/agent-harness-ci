import {
  UNKNOWN_FORGE_CAPABILITIES,
  type ForgeAlias,
  type ForgeCapabilities,
  type ForgeCapability,
  type ForgeIdentity,
  type ForgeOrigin,
  type ForgeProblem,
  type ForgeTokenInformation,
} from "@agent-harness/contracts";
import { adviceLine, type Advice, belongsToOther, notAnswering, runsOutSoon, siteOf, tokenRefused } from "./lines.js";
import type { CallOptions, ForgeProvider, IdentityAnswer, ReadAnswer, Unreachable } from "./providers.js";

/**
 * One verification of a credential (forge spec, "Verification"; ADR 0020),
 * in two halves: what the forge answers (`verifyCredential`), and what that
 * makes of what was known (`reconcile`). Neither records anything: the
 * ForgeService's verifier records a forge account's, and the state import's
 * credential probe is the two halves with nothing known and no record.
 *
 * - **Identity first.** The identity endpoint answers who the token is and,
 *   on GitHub, its kind, scopes and expiry. A refusal is
 *   `credential-rejected`, no answer `unreachable`; another user id than the
 *   one known is `identity-changed`, and nothing else it answers is taken; a
 *   changed login with the same user id is the identity now.
 * - **Two reads probed.** `readRepository` on a repository this environment
 *   knows on the origin, else by listing repositories; `readReleases` on the
 *   same repository, else following `readRepository`, which grants release
 *   reads on every kind. A read the forge refuses (401, 403, a 404) is
 *   failed with its status, keeping when it was last verified; one it could
 *   not answer now is left as it was, and the forge account is `unreachable`
 *   until a verification reads it again, so a forge that met a server error
 *   is never done (#1850). Writes are never probed: they stay as use has
 *   shown them.
 * - **Aliases** are asked on their own origin, and verified only when they
 *   answer as the same login and user id; a refusal or another identity
 *   leaves one unverified; no answer leaves it as it was.
 * - **Expiry.** A token expiring within thirty days is `expiring`.
 * - **A problem of the kind there was** keeps its since-time, so the status
 *   a person sees holds since it began.
 * - **Lines** are setup-copy.md §5.6's (`lines.ts`): what the forge
 *   answered, its statuses and the user ids are the problem's details.
 */

/** A token expiring within this long is `expiring` (ADR 0033's rule, for every kind that reports expiry). */
export const EXPIRING_WITHIN_MS = 30 * 24 * 60 * 60_000;

/** What a verification asks the forge. */
export interface VerificationRequest {
  readonly origin: ForgeOrigin;
  readonly token: string;
  /** Who the credential should answer as; null when it never has. Another user id is probed no further. */
  readonly expected: ForgeIdentity | null;
  /** A repository this environment knows on the origin (`owner/name`), which both reads are probed on; null to probe by listing. */
  readonly repository: string | null;
  /** The alias origins to ask on. */
  readonly aliases: readonly ForgeOrigin[];
}

/** What the forge answered a verification. */
export type Found =
  | {
      readonly outcome: "identified";
      readonly identity: ForgeIdentity;
      readonly tokenInformation: ForgeTokenInformation;
      /** Each read's probe; null when the credential answered as another user, whose reads say nothing of this forge account. */
      readonly reads: { readonly readRepository: ReadAnswer; readonly readReleases: ReadAnswer } | null;
      readonly aliases: ReadonlyMap<ForgeOrigin, IdentityAnswer>;
    }
  | Exclude<IdentityAnswer, { readonly outcome: "identified" }>
  /** No token to ask with: the credential could not be read. */
  | { readonly outcome: "unavailable"; readonly problem: ForgeProblem };

const sameUser = (one: ForgeIdentity, other: ForgeIdentity | null): boolean => other === null || one.userId === other.userId;

/** Asks the forge what a verification needs to know of `request.token`, within `call`'s signal. */
export const verifyCredential = async (provider: ForgeProvider, request: VerificationRequest, call: CallOptions): Promise<Found> => {
  const { origin, token, repository } = request;
  const answer = await provider.identity(origin, token, call);
  if (answer.outcome !== "identified") return answer;
  const { identity, tokenInformation } = answer;
  if (!sameUser(identity, request.expected)) return { outcome: "identified", identity, tokenInformation, reads: null, aliases: new Map() };
  const readRepository = await provider.readRepository(origin, token, repository, call);
  // With no repository known, release reads follow the repository read: every kind grants them with it.
  const readReleases = repository === null ? readRepository : await provider.readReleases(origin, token, repository, call);
  const aliases = new Map(await Promise.all(request.aliases.map(async (alias) => [alias, await provider.identity(alias, token, call)] as const)));
  return { outcome: "identified", identity, tokenInformation, reads: { readRepository, readReleases }, aliases };
};

/** What is known of a forge account before a verification: its record, with the verified-at times kept beside it. */
export interface Known {
  readonly identity: ForgeIdentity | null;
  readonly capabilities: ForgeCapabilities;
  readonly tokenInformation: ForgeTokenInformation | null;
  readonly problem: ForgeProblem | null;
  readonly aliases: readonly ForgeAlias[];
}

/** Nothing known: a credential no forge account holds, as the state import's probe asks about it. */
export const NOTHING_KNOWN: Known = { identity: null, capabilities: UNKNOWN_FORGE_CAPABILITIES, tokenInformation: null, problem: null, aliases: [] };

/** What a verification makes of what was known. */
export interface Reconciled extends Known {
  /** Whether the identity, a capability, the token information or the problem's kind changed: what `forge.account.verified` is appended for. */
  readonly changed: boolean;
  /** Whether an alias became verified or stopped being. */
  readonly aliasesChanged: boolean;
}

const probed = (before: ForgeCapability, answer: ReadAnswer, at: string): ForgeCapability => {
  switch (answer.outcome) {
    case "verified":
      return { state: "verified", verifiedAt: at, status: null };
    case "failed":
      return { state: "failed", verifiedAt: before.verifiedAt, status: answer.status };
    case "unreachable":
      return before;
  }
};

const sameCapability = (one: ForgeCapability, other: ForgeCapability): boolean => one.state === other.state && one.status === other.status;

/** `found`, since when a problem of its kind began: `before`'s since-time when it is of the same kind. */
export const keepSince = (before: ForgeProblem | null, found: ForgeProblem | null): ForgeProblem | null =>
  found !== null && before !== null && before.kind === found.kind ? { ...found, since: before.since } : found;

const describeIdentity = (identity: ForgeIdentity): string => `${identity.login} (user ${identity.userId})`;

/** Whether a client shows another problem: another kind, or another line, as a forge that did not answer now answering with a server error, or a line recorded before setup-copy.md §5.6's. */
const problemChanged = (before: ForgeProblem | null, after: ForgeProblem | null): boolean => before?.kind !== after?.kind || before?.message !== after?.message;

/** `2026-10-15 12:00 UTC`: an instant to the minute, for a line a person reads. */
export const readableMinute = (at: string): string => `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;

/** Whom a problem's line is about, and how it ends. */
export interface ReconcileOptions {
  /** The forge's origin, whose host the lines name. */
  readonly origin: ForgeOrigin;
  /** Whether the lines say what a person does about the problem, for a forge account; preset: they do. A credential no forge account holds yet says only what happened. */
  readonly remedies?: boolean;
}

/**
 * What `found` makes of `known` at `now`: the state to hold, and whether it
 * changed anything a client shows.
 */
export const reconcile = (known: Known, found: Found, now: Date, options: ReconcileOptions): Reconciled => {
  const site = siteOf(options.origin);
  const at = now.toISOString();
  const problemNow = (kind: ForgeProblem["kind"], advice: Advice, details: readonly string[]): ForgeProblem => ({
    kind,
    since: at,
    message: adviceLine(advice, options.remedies !== false),
    ...(details.length > 0 && { details: [...new Set(details)] }),
  });
  /** The problem a forge that could not answer leaves: one that answered it cannot now (a server error) is not answering properly, one that gave no answer did not answer. */
  const unanswered = (answers: readonly Unreachable[]): ForgeProblem =>
    problemNow("unreachable", notAnswering(site, answers.find((answer) => answer.status !== undefined)?.status), answers.map((answer) => answer.message));
  const unchanged = { ...known, changed: false, aliasesChanged: false };
  /** Only the problem changes: the rest stays as it was known. */
  const withProblem = (problem: ForgeProblem): Reconciled => {
    const kept = keepSince(known.problem, problem);
    return { ...unchanged, problem: kept, changed: problemChanged(known.problem, kept) };
  };
  switch (found.outcome) {
    case "unavailable":
      return withProblem(found.problem);
    case "refused":
      return withProblem(problemNow("credential-rejected", tokenRefused(site, known.identity?.login ?? null), [found.message]));
    case "unreachable":
      return withProblem(unanswered([found]));
    case "identified":
      break;
  }
  const { identity, tokenInformation, reads } = found;
  if (reads === null) {
    const expected = known.identity ?? identity;
    return withProblem(
      problemNow("identity-changed", belongsToOther(site, identity.login, expected.login), [`The token answers as ${describeIdentity(identity)}, not ${describeIdentity(expected)}.`]),
    );
  }
  const capabilities: ForgeCapabilities = {
    ...known.capabilities,
    readRepository: probed(known.capabilities.readRepository, reads.readRepository, at),
    readReleases: probed(known.capabilities.readReleases, reads.readReleases, at),
  };
  const expiresAt = tokenInformation.expiresAt;
  const expiring = expiresAt !== null && Date.parse(expiresAt) - now.getTime() <= EXPIRING_WITHIN_MS;
  // A read the forge could not answer now leaves the forge account unreachable until one does: what it may read is not known.
  const unansweredReads = [reads.readRepository, reads.readReleases].filter((answer): answer is Unreachable => answer.outcome === "unreachable");
  const problem = keepSince(
    known.problem,
    unansweredReads.length > 0 ? unanswered(unansweredReads) : expiring ? problemNow("expiring", runsOutSoon(site), [`Runs out at: ${expiresAt}`]) : null,
  );
  const aliases = known.aliases.map((alias): ForgeAlias => {
    const answer = found.aliases.get(alias.origin);
    if (answer === undefined || answer.outcome === "unreachable") return alias;
    const same = answer.outcome === "identified" && answer.identity.login === identity.login && answer.identity.userId === identity.userId;
    return { origin: alias.origin, verifiedAt: same ? at : null };
  });
  const changed =
    known.identity?.login !== identity.login ||
    known.identity.userId !== identity.userId ||
    JSON.stringify(known.tokenInformation) !== JSON.stringify(tokenInformation) ||
    problemChanged(known.problem, problem) ||
    !sameCapability(known.capabilities.readRepository, capabilities.readRepository) ||
    !sameCapability(known.capabilities.readReleases, capabilities.readReleases);
  const aliasesChanged = aliases.some((alias, index) => (alias.verifiedAt === null) !== (known.aliases[index]?.verifiedAt === null));
  return { identity, capabilities, tokenInformation, problem, aliases, changed, aliasesChanged };
};

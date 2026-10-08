import { GH_MINIMUM_VERSION, type ForgeAccountRecord, type ForgeCapabilityName, type ForgeProblem, type ForgeProblemKind, type GhProbe, type SetupAction, type SetupTarget, type StateCheckId } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { StateChecker } from "../setup/check.js";
import type { Clock } from "../serve/clock.js";
import type { ForgeService } from "./forge-service.js";
import type { MissingOrigin } from "./forge-store.js";
import {
  CHOOSE_MAIN,
  GH_MISSING,
  GH_OLD,
  NO_FORGE,
  accountWords,
  adviceLine,
  belongsToOther,
  cannotRead,
  checkingReads,
  ghGaveNoToken,
  ghLoginCommand,
  ghSignedOutAdvice,
  neededElsewhere,
  noToken,
  ranOut,
  runsOutIn,
  savedTokenUnreadable,
  siteOf,
  tokenRefused,
  type Read,
} from "./lines.js";
import { EXPIRING_WITHIN_MS } from "./verification.js";

/**
 * The Forges step's state checks (forge spec, "The Forges step"; setup
 * spec, "Skipped"; ADR 0020, ADR 0031; #319), answered from the
 * ForgeService. `forges.present` is the step's skip check: with no forge
 * account the step answers skipped and asks nothing else. The checks that
 * read what a verification finds read what the last one found while it is
 * younger than the age their check gives, the step's cadence on the
 * environment's own schedule and none on a client's, and otherwise await
 * one, never past a pause the forge asked for (#680). They share it: a
 * verification asked for while one runs for the same credential joins it
 * (`verifier.ts`). A failing line is setup-copy.md §5.6's: it names each
 * forge by its site and says the one thing to do, with the action that does
 * it; HTTP statuses, user ids, exact times and what a forge or `gh` answered
 * are in details (#1850).
 */

/** The Forges step's state checks, by id. */
type ForgesStateCheckId = Extract<StateCheckId, `forges.${string}`>;

/** A forge account's site: its origin's host, with the port an origin names. */
const hostOf = (account: ForgeAccountRecord): string => siteOf(account.origin);

/** A forge account as a person reads it: its login on its origin's host, or the host until the forge has answered who it is. */
const forgeAccountLabel = (account: ForgeAccountRecord): string => accountWords(account.origin, account.identity?.login ?? null);

/** The forge account `action` applies to. */
const forgeAccountTarget = (action: SetupAction, account: ForgeAccountRecord): SetupTarget => ({
  action,
  kind: "forge-account",
  id: account.origin,
  label: forgeAccountLabel(account),
});

/** One forge account's failure of a check: its line, the raw facts behind it, and the forge account its action applies to. */
interface Finding {
  readonly line: string;
  readonly details?: readonly string[];
  readonly target?: SetupTarget;
}

/** What a failure offers when it applies to `targets`: their actions alone, so a line's one fix is the one offered (a forge not answering properly offers no Sign in again). */
const offering = (targets: readonly SetupTarget[]) => ({ targets, actions: [...new Set(targets.map((target) => target.action))] });

/** A check's answer from its findings: it holds with none, else one line naming each, with their details, targets and those targets' actions. */
const answerOf = (findings: readonly Finding[]): StateCheckAnswer => {
  if (findings.length === 0) return true;
  const details = findings.flatMap((finding) => finding.details ?? []);
  const targets = findings.flatMap((finding) => (finding.target === undefined ? [] : [finding.target]));
  return { reason: findings.map((finding) => finding.line).join(" "), ...(details.length > 0 && { details }), ...(targets.length > 0 && offering(targets)) };
};

/** At least one forge account is on the environment. */
const forgesPresent = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer => accounts.length > 0 || { reason: NO_FORGE };

/** A problem that says a forge account does not answer as the identity it was added with. */
type IdentityProblem = Exclude<ForgeProblemKind, "expiring">;

/** The action that fixes each identity problem: a new token, or asking again a forge that did not answer. */
const IDENTITY_ACTIONS: { readonly [Kind in IdentityProblem]: SetupAction } = {
  "needs-credential": "sign-in-again",
  "credential-rejected": "sign-in-again",
  "credential-unavailable": "sign-in-again",
  "identity-changed": "sign-in-again",
  unreachable: "check-again",
};

/** A token that answers as another user, as setup-copy.md §5.6 says it: the line a verification writes since #1850. */
const BELONGS_TO_OTHER = /^The token for .+ belongs to .+, not .+\. Add a token for .+\.$/;

/**
 * A forge account's identity problem as the step's line says it. A token
 * that answers as another user, and a forge that did not answer or answered
 * with a server error, are the problem's own line, which the verification
 * that found it wrote; the rest are said from what the record holds. A token
 * an older build recorded as answering as another user keeps its old line,
 * since such an account is never verified again: the step says it as §5.6
 * does, the other user unnamed, and the old line goes to details.
 */
const identityLine = (account: ForgeAccountRecord, kind: IdentityProblem, problem: ForgeProblem): string => {
  const site = hostOf(account);
  switch (kind) {
    case "needs-credential":
      return noToken(site);
    case "credential-rejected":
      return adviceLine(tokenRefused(site, account.identity?.login ?? null));
    case "credential-unavailable":
      return account.credential.kind === "gh" ? ghGaveNoToken(forgeAccountLabel(account)) : savedTokenUnreadable(forgeAccountLabel(account), account.credential.kind === "reference");
    case "identity-changed": {
      const login = account.identity?.login;
      return BELONGS_TO_OTHER.test(problem.message) || login === undefined ? problem.message : adviceLine(belongsToOther(site, "another user", login));
    }
    case "unreachable":
      return problem.message;
  }
};

/** The raw facts behind a problem: its details, after its own line when the step's line says it otherwise. */
const problemDetails = (line: string, problem: ForgeProblem): readonly string[] => [...(problem.message === line ? [] : [problem.message]), ...(problem.details ?? [])];

/** Whether the forge account answers as the identity it was added with: no problem but an expiring token. */
const answersAsItself = (account: ForgeAccountRecord): boolean => account.problem === null || account.problem.kind === "expiring";

/** Each forge account answers as the identity it was added with (`sign-in-again` for its token, `check-again` for a forge that did not answer). */
const identitiesHold = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer =>
  answerOf(
    accounts.flatMap((account) => {
      const { problem } = account;
      if (problem === null || problem.kind === "expiring") return [];
      const line = identityLine(account, problem.kind, problem);
      return [{ line, details: problemDetails(line, problem), target: forgeAccountTarget(IDENTITY_ACTIONS[problem.kind], account) }];
    }),
  );

/** The reads a verification probes, as a line names them. */
const READS: readonly (readonly [ForgeCapabilityName, Read])[] = [
  ["readRepository", "read code"],
  ["readReleases", "read releases"],
];

/**
 * Every read of each forge account passes: each read a verification probes
 * is verified (`check-again`). A read the forge refused is named as what the
 * token cannot do, the status it answered in details; one it has not
 * answered yet is still being checked. A forge account that does not answer
 * as its identity is `forges.identity`'s to name, its reads never probed.
 */
const readsHold = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer =>
  answerOf(
    accounts.filter(answersAsItself).flatMap((account) => {
      const refused = READS.filter(([name]) => account.capabilities[name].state === "failed");
      const unanswered = READS.filter(([name]) => account.capabilities[name].state === "unknown");
      const target = forgeAccountTarget("check-again", account);
      if (refused.length > 0) {
        const details = refused.map(([name]) => {
          const { status } = account.capabilities[name];
          return `${forgeAccountLabel(account)}: ${name} ${status === null ? "was refused" : `answered HTTP ${status}`}`;
        });
        return [{ line: cannotRead(hostOf(account), refused.map(([, read]) => read)), details, target }];
      }
      return unanswered.length > 0 ? [{ line: checkingReads(hostOf(account)), target }] : [];
    }),
  );

/**
 * Exactly one forge account is primary (ADR 0012): removing the primary
 * leaves none until a person chooses one, which the line asks, the forge
 * accounts to choose from in details. The card's Make main is the fix, no
 * verb of the vocabulary, so the check offers no action.
 */
const onePrimary = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer => {
  const primaries = accounts.filter((account) => account.primary);
  if (primaries.length === 1) return true;
  if (primaries.length === 0) return { reason: CHOOSE_MAIN, details: [`Forges to choose from: ${accounts.map(forgeAccountLabel).join(", ")}`] };
  return { reason: CHOOSE_MAIN, details: [`Main forges: ${primaries.map(forgeAccountLabel).join(", ")}`] };
};

/** `gh` as the tool `action` applies to (ADR 0026's Managed tools row): Install or Update. */
const ghTarget = (action: SetupAction): SetupTarget => ({ action, kind: "tool", id: "gh", label: "gh" });

/**
 * Every forge account whose credential is the environment's `gh` finds it
 * installed (`install`), at the minimum or later (`update`), and signed in
 * to the forge account's host as its login (`sign-in-again`), as `gh auth
 * status` reports them (ADR 0032). `gh` is asked only when a forge account
 * reads it. Signed in is asked of a `gh` at the minimum alone, the first
 * that reads a token per login. Its version, the minimum and the forge
 * accounts that read it are in details.
 */
const ghHolds = async (accounts: readonly ForgeAccountRecord[], probe: () => Promise<GhProbe>): Promise<StateCheckAnswer> => {
  const readers = accounts.flatMap((account) => (account.credential.kind === "gh" ? [{ account, login: account.credential.login }] : []));
  if (readers.length === 0) return true;
  const gh = await probe();
  const usedBy = `used by ${readers.map(({ account }) => forgeAccountLabel(account)).join(", ")}`;
  if (!gh.installed) return { reason: GH_MISSING, details: [`Needs gh ${GH_MINIMUM_VERSION} or later, ${usedBy}`], ...offering([ghTarget("install")]) };
  if (!gh.meetsMinimum) {
    const which = gh.version === null ? "gh reports no version" : `gh ${gh.version}`;
    return { reason: GH_OLD, details: [`${which} (needs ${GH_MINIMUM_VERSION} or later), ${usedBy}`], ...offering([ghTarget("update")]) };
  }
  return answerOf(
    readers
      .filter(({ account, login }) => !gh.accounts.some((signedIn) => signedIn.host === hostOf(account) && signedIn.login === login))
      .map(({ account, login }) => ({
        line: ghSignedOutAdvice(hostOf(account)),
        details: [ghLoginCommand(hostOf(account), login)],
        target: forgeAccountTarget("sign-in-again", account),
      })),
  );
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * No forge account's token expires within thirty days of `now` (ADR 0033's
 * rule, for every kind that reports an expiry: what the last verification
 * read), naming each that does with the days left, the exact time in
 * details (`sign-in-again`).
 */
const nothingExpiring = (accounts: readonly ForgeAccountRecord[], now: Date): StateCheckAnswer =>
  answerOf(
    accounts.flatMap((account) => {
      const expiresAt = account.tokenInformation?.expiresAt ?? null;
      if (expiresAt === null) return [];
      const left = Date.parse(expiresAt) - now.getTime();
      if (left > EXPIRING_WITHIN_MS) return [];
      const line = left <= 0 ? ranOut(hostOf(account)) : runsOutIn(hostOf(account), Math.ceil(left / DAY_MS));
      return [{ line, details: [`Runs out at: ${expiresAt}`], target: forgeAccountTarget("sign-in-again", account) }];
    }),
  );

/**
 * No missing origin counts (forge spec, "No forge account"): each origin a
 * harness operation was refused on for want of a forge account, recorded
 * within seven days and covered by none since, is named by its site, the
 * operation and when in details. Adding a forge account for it is the card's
 * Add a forge, no verb of the vocabulary, so the check offers no action.
 */
const originsCovered = (missing: readonly MissingOrigin[]): StateCheckAnswer =>
  answerOf(missing.map(({ origin, operation, recordedAt }) => ({ line: neededElsewhere(siteOf(origin)), details: [`${origin}: could not ${operation} at ${recordedAt}`] })));

export interface ForgesStateChecksOptions {
  readonly forge: ForgeService;
  /** The environment's clock, which an expiry is read against. */
  readonly clock: Clock;
}

/** How the environment answers the Forges step's state checks. */
export const forgesStateChecks = ({ forge, clock }: ForgesStateChecksOptions): { readonly [Id in ForgesStateCheckId]: StateChecker } => ({
  "forges.present": () => forgesPresent(forge.list()),
  "forges.identity": async ({ maxAgeMs }) => identitiesHold(await forge.verifiedWithin(maxAgeMs)),
  "forges.reads": async ({ maxAgeMs }) => readsHold(await forge.verifiedWithin(maxAgeMs)),
  "forges.primary": () => onePrimary(forge.list()),
  "forges.gh": () => ghHolds(forge.list(), () => forge.probeGh()),
  "forges.expiry": async ({ maxAgeMs }) => nothingExpiring(await forge.verifiedWithin(maxAgeMs), clock.now()),
  "forges.coverage": () => originsCovered(forge.missingOrigins()),
});

import { GH_MINIMUM_VERSION, type ForgeAccountRecord, type ForgeCapabilityName, type ForgeProblemKind, type GhProbe, type SetupAction, type SetupTarget, type StateCheckId } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { StateChecker } from "../setup/check.js";
import type { Clock } from "../serve/clock.js";
import type { ForgeService } from "./forge-service.js";
import type { MissingOrigin } from "./forge-store.js";
import { EXPIRING_WITHIN_MS, readableMinute } from "./verification.js";

/**
 * The Forges step's state checks (forge spec, "The Forges step"; setup
 * spec, "Skipped"; ADR 0020, ADR 0031; #319), answered from the
 * ForgeService. `forges.present` is the step's skip check: with no forge
 * account the step answers skipped and asks nothing else. The checks that
 * read what a verification finds await one of every forge account, which
 * they share: a verification asked for while one runs for the same
 * credential joins it (`verifier.ts`). A failing line names each forge
 * account, as its login on its origin's host, and the action that fixes it.
 */

/** The Forges step's state checks, by id. */
type ForgesStateCheckId = Extract<StateCheckId, `forges.${string}`>;

/** A forge account's origin without its scheme: its host, with the port an origin names, as `gh` names an Enterprise host too. */
const hostOf = (account: ForgeAccountRecord): string => account.origin.replace(/^https?:\/\//, "");

/** A forge account as a person reads it: its login on its origin's host, or the host until the forge has answered who it is. */
const forgeAccountLabel = (account: ForgeAccountRecord): string => (account.identity === null ? hostOf(account) : `${account.identity.login} on ${hostOf(account)}`);

/** The forge account `action` applies to. */
const forgeAccountTarget = (action: SetupAction, account: ForgeAccountRecord): SetupTarget => ({
  action,
  kind: "forge-account",
  id: account.origin,
  label: forgeAccountLabel(account),
});

/** One forge account's failure of a check: its line, and the forge account its action applies to. */
interface Finding {
  readonly line: string;
  readonly target: SetupTarget;
}

/** A check's answer from its findings: it holds with none, else one line naming each, with their targets. */
const answerOf = (findings: readonly Finding[]): StateCheckAnswer =>
  findings.length === 0 ? true : { reason: findings.map((finding) => finding.line).join(" "), targets: findings.map((finding) => finding.target) };

/** At least one forge account is on the environment. */
const forgesPresent = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer =>
  accounts.length > 0 || { reason: "No forge account is on this environment." };

/** The problems that say a forge account does not answer as the identity it was added with, each with its action and line. */
const IDENTITY_PROBLEMS: { readonly [Kind in Exclude<ForgeProblemKind, "expiring">]: { readonly action: SetupAction; readonly line: (account: ForgeAccountRecord) => string } } = {
  "needs-credential": { action: "sign-in-again", line: (account) => `${forgeAccountLabel(account)} has no credential on this environment: Sign in again to give it one.` },
  "credential-rejected": { action: "sign-in-again", line: (account) => `The forge refused the credential of ${forgeAccountLabel(account)}: Sign in again to give it a new one.` },
  "credential-unavailable": { action: "sign-in-again", line: (account) => `The credential of ${forgeAccountLabel(account)} could not be read: Sign in again to give it a new one.` },
  "identity-changed": {
    action: "sign-in-again",
    line: (account) => `The credential of ${forgeAccountLabel(account)} now answers as another user: Sign in again as ${account.identity?.login ?? "the user it was added as"}.`,
  },
  unreachable: { action: "check-again", line: (account) => `${forgeAccountLabel(account)} did not answer its verification: Check again once its forge is reachable.` },
};

/** Whether the forge account answers as the identity it was added with: no problem but an expiring token. */
const answersAsItself = (account: ForgeAccountRecord): boolean => account.problem === null || account.problem.kind === "expiring";

/** Each forge account answers as the identity it was added with (`sign-in-again` for its credential, `check-again` for a forge that did not answer). */
const identitiesHold = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer =>
  answerOf(
    accounts.flatMap((account) => {
      const { problem } = account;
      if (problem === null || problem.kind === "expiring") return [];
      const { action, line } = IDENTITY_PROBLEMS[problem.kind];
      return [{ line: line(account), target: forgeAccountTarget(action, account) }];
    }),
  );

/** The reads a verification probes, as a line names them. */
const READS: readonly (readonly [ForgeCapabilityName, string])[] = [
  ["readRepository", "repositories"],
  ["readReleases", "releases"],
];

/**
 * Every read of each forge account passes: each read a verification probes
 * is verified (`check-again`). A read the forge refused is named with the
 * status it answered, one it has not answered yet as such. A forge account
 * that does not answer as its identity is `forges.identity`'s to name, its
 * reads never probed.
 */
const readsHold = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer =>
  answerOf(
    accounts.filter(answersAsItself).flatMap((account) => {
      const refused = READS.filter(([name]) => account.capabilities[name].state === "failed").map(([name, what]) => {
        const { status } = account.capabilities[name];
        return status === null ? what : `${what} (HTTP ${status})`;
      });
      const unanswered = READS.filter(([name]) => account.capabilities[name].state === "unknown").map(([, what]) => what);
      if (refused.length === 0 && unanswered.length === 0) return [];
      const clauses = [
        ...(refused.length > 0 ? [`was refused reading ${refused.join(" and ")}`] : []),
        ...(unanswered.length > 0 ? [`has no answer yet reading ${unanswered.join(" and ")}`] : []),
      ];
      const remedy = refused.length > 0 ? "Check again once its token may read them." : "Check again once its forge answers.";
      return [{ line: `${forgeAccountLabel(account)} ${clauses.join(", and ")}: ${remedy}`, target: forgeAccountTarget("check-again", account) }];
    }),
  );

/**
 * Exactly one forge account is primary (ADR 0012): removing the primary
 * leaves none until a person chooses one, which the line asks naming the
 * forge accounts to choose from. The card's Make primary is the fix, no verb
 * of the vocabulary, so the check offers no action.
 */
const onePrimary = (accounts: readonly ForgeAccountRecord[]): StateCheckAnswer => {
  const primaries = accounts.filter((account) => account.primary);
  if (primaries.length === 1) return true;
  if (primaries.length === 0) return { reason: `No forge account is primary: choose ${accounts.map(forgeAccountLabel).join(" or ")} with Make primary.` };
  return { reason: `${primaries.map(forgeAccountLabel).join(" and ")} are all primary: choose one with Make primary.` };
};

/** `gh` as the tool `action` applies to (ADR 0026's Managed tools row): Install or Update. */
const ghTarget = (action: SetupAction): SetupTarget => ({ action, kind: "tool", id: "gh", label: "gh" });

/**
 * Every forge account whose credential is the environment's `gh` finds it
 * installed (`install`), at the minimum or later (`update`), and signed in
 * to the forge account's host as its login (`sign-in-again`), as `gh auth
 * status` reports them (ADR 0032). `gh` is asked only when a forge account
 * reads it. Signed in is asked of a `gh` at the minimum alone, the first
 * that reads a token per login.
 */
const ghHolds = async (accounts: readonly ForgeAccountRecord[], probe: () => Promise<GhProbe>): Promise<StateCheckAnswer> => {
  const readers = accounts.flatMap((account) => (account.credential.kind === "gh" ? [{ account, login: account.credential.login }] : []));
  if (readers.length === 0) return true;
  const gh = await probe();
  const labels = readers.map(({ account }) => forgeAccountLabel(account)).join(" and ");
  if (!gh.installed) return { reason: `gh is not installed on this environment for ${labels}: Install gh ${GH_MINIMUM_VERSION} or later.`, targets: [ghTarget("install")] };
  if (!gh.meetsMinimum) {
    const which = gh.version === null ? "gh on this environment reports no version, so it may be older" : `gh ${gh.version} on this environment is older`;
    return { reason: `${which} than ${GH_MINIMUM_VERSION} for ${labels}: Update gh.`, targets: [ghTarget("update")] };
  }
  return answerOf(
    readers
      .filter(({ account, login }) => !gh.accounts.some((signedIn) => signedIn.host === hostOf(account) && signedIn.login === login))
      .map(({ account, login }) => ({
        line: `gh on this environment is not signed in to ${hostOf(account)} as ${login}: Sign in again.`,
        target: forgeAccountTarget("sign-in-again", account),
      })),
  );
};

/**
 * No forge account's token expires within thirty days of `now` (ADR 0033's
 * rule, for every kind that reports an expiry: what the last verification
 * read), naming each that does with the time (`sign-in-again`).
 */
const nothingExpiring = (accounts: readonly ForgeAccountRecord[], now: Date): StateCheckAnswer =>
  answerOf(
    accounts.flatMap((account) => {
      const expiresAt = account.tokenInformation?.expiresAt ?? null;
      if (expiresAt === null || Date.parse(expiresAt) - now.getTime() > EXPIRING_WITHIN_MS) return [];
      const line =
        Date.parse(expiresAt) <= now.getTime()
          ? `The token of ${forgeAccountLabel(account)} expired at ${readableMinute(expiresAt)}: Sign in again to give it a new one.`
          : `The token of ${forgeAccountLabel(account)} expires at ${readableMinute(expiresAt)}: Sign in again to give it a new one before then.`;
      return [{ line, target: forgeAccountTarget("sign-in-again", account) }];
    }),
  );

/**
 * No missing origin counts (forge spec, "No forge account"): each origin a
 * harness operation was refused on for want of a forge account, recorded
 * within seven days and covered by none since, is named with the operation
 * and when. Adding a forge account for it is the card's Add a forge, no verb
 * of the vocabulary, so the check offers no action.
 */
const originsCovered = (missing: readonly MissingOrigin[]): StateCheckAnswer =>
  missing.length === 0 || {
    reason: missing
      .map(({ origin, operation, recordedAt }) => `No forge account covers ${origin}, where the harness could not ${operation} at ${readableMinute(recordedAt)}: add a forge account for it.`)
      .join(" "),
  };

export interface ForgesStateChecksOptions {
  readonly forge: ForgeService;
  /** The environment's clock, which an expiry is read against. */
  readonly clock: Clock;
}

/** How the environment answers the Forges step's state checks. */
export const forgesStateChecks = ({ forge, clock }: ForgesStateChecksOptions): { readonly [Id in ForgesStateCheckId]: StateChecker } => ({
  "forges.present": () => forgesPresent(forge.list()),
  "forges.identity": async () => identitiesHold(await forge.verify()),
  "forges.reads": async () => readsHold(await forge.verify()),
  "forges.primary": () => onePrimary(forge.list()),
  "forges.gh": () => ghHolds(forge.list(), () => forge.probeGh()),
  "forges.expiry": async () => nothingExpiring(await forge.verify(), clock.now()),
  "forges.coverage": () => originsCovered(forge.missingOrigins()),
});

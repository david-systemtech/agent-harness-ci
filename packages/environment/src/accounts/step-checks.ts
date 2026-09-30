import type { AccountRecord, AccountStatusState, SetupTarget, StateCheckId } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { StateChecker } from "../setup/check.js";

/**
 * The Account step's state checks (ADR 0018; setup spec, "1. Account";
 * #574), answered from the statuses the account store holds (#134), which
 * it reads at start, on `accounts.refresh` and at most every fifteen minutes
 * otherwise: a check reads no account's status itself, so the store's reads
 * stay rate-limited. The step is never skipped: with no account it needs
 * attention with no action, since the card's Sign in is the fix; an account
 * that is not signed in is named with Sign in again, which opens its
 * sign-in.
 */

/** The Account step's state checks, by id. */
type AccountStateCheckId = Extract<StateCheckId, `account.${string}`>;

export interface AccountStateChecksOptions {
  /** The accounts the store holds now, each with its latest status (`AccountService.list`). */
  readonly accounts: () => readonly AccountRecord[];
}

/** What an account's status that is not signed in says, as a line naming it. */
const NOT_SIGNED_IN: { readonly [State in Exclude<AccountStatusState, "signed-in">]: (account: AccountRecord) => string } = {
  "signed-out": (account) => `${account.label} is signed out: Sign in again.`,
  expired: (account) => `The sign-in of ${account.label} has expired: Sign in again.`,
  unreadable: (account) => {
    const why = account.status.detail?.replace(/\.$/, "");
    return `The status of ${account.label} could not be read${why === undefined ? "" : ` (${why})`}: Sign in again.`;
  },
};

/** The account Sign in again opens the sign-in of. */
const signInAgain = (account: AccountRecord): SetupTarget => ({ action: "sign-in-again", kind: "account", id: account.id, label: account.label });

/** At least one account is on the environment. */
const accountPresent = (accounts: readonly AccountRecord[]): StateCheckAnswer =>
  accounts.length > 0 || { reason: "No account is added on this environment: Sign in adds one." };

/** Every account is signed in: each that is not is named, in the store's order, with Sign in again. */
const everySignedIn = (accounts: readonly AccountRecord[]): StateCheckAnswer => {
  const lines: string[] = [];
  const targets: SetupTarget[] = [];
  for (const account of accounts) {
    const { state } = account.status;
    if (state === "signed-in") continue;
    lines.push(NOT_SIGNED_IN[state](account));
    targets.push(signInAgain(account));
  }
  return lines.length === 0 || { reason: lines.join(" "), targets };
};

export const accountStateChecks = ({ accounts }: AccountStateChecksOptions): { readonly [Id in AccountStateCheckId]: StateChecker } => ({
  "account.present": () => accountPresent(accounts()),
  "account.signed-in": () => everySignedIn(accounts()),
});

import type { AccountRecord, AccountStatusState, SetupAction, SetupTarget, StateCheckId } from "@agent-harness/contracts";
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
  // setup-copy.md §5.1: Check again, not Sign in again, the read's error in details.
  unreadable: (account) => `agent-harness could not read ${account.label}'s sign-in. Choose Check again.`,
};

/** The account Sign in again opens the sign-in of. */
const signInAgain = (account: AccountRecord): SetupTarget => ({ action: "sign-in-again", kind: "account", id: account.id, label: account.label });

/** At least one account is on the environment. */
const accountPresent = (accounts: readonly AccountRecord[]): StateCheckAnswer =>
  accounts.length > 0 || { reason: "No account is added on this environment: Sign in adds one." };

/** Every account is signed in: each that is not is named, in the store's order, with Sign in again, or Check again for one whose status could not be read. */
const everySignedIn = (accounts: readonly AccountRecord[]): StateCheckAnswer => {
  const lines: string[] = [];
  const details: string[] = [];
  const targets: SetupTarget[] = [];
  const actions = new Set<SetupAction>();
  for (const account of accounts) {
    const { state, detail } = account.status;
    if (state === "signed-in") continue;
    lines.push(NOT_SIGNED_IN[state](account));
    // An unreadable status is read again; a sign-in that is not there is signed in again.
    if (state === "unreadable") {
      actions.add("check-again");
      if (detail !== undefined) details.push(`${account.label}: ${detail}`);
    } else {
      actions.add("sign-in-again");
      targets.push(signInAgain(account));
    }
  }
  return lines.length === 0 || { reason: lines.join(" "), details, targets, actions: [...actions] };
};

export const accountStateChecks = ({ accounts }: AccountStateChecksOptions): { readonly [Id in AccountStateCheckId]: StateChecker } => ({
  "account.present": () => accountPresent(accounts()),
  "account.signed-in": () => everySignedIn(accounts()),
});

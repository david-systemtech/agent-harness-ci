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
 * sign-in. The lines are setup-copy.md §5.1's: labels only, never a method,
 * a path or an id.
 */

/** The Account step's state checks, by id. */
type AccountStateCheckId = Extract<StateCheckId, `account.${string}`>;

export interface AccountStateChecksOptions {
  /** The accounts the store holds now, each with its latest status (`AccountService.list`). */
  readonly accounts: () => readonly AccountRecord[];
}

/** What one account that needs to sign in again says (setup-copy.md §5.1): its label, never its directory or id. */
const SIGN_IN_AGAIN_LINE: { readonly [State in Exclude<AccountStatusState, "signed-in" | "unreadable">]: (label: string) => string } = {
  "signed-out": (label) => `${label} is signed out. Sign in again to use it.`,
  expired: (label) => `${label}'s sign-in has run out. Sign in again to keep using it.`,
};

/** The accounts that need to sign in again, in one line: the one by its state, several by how many and their labels. */
const signInAgainLine = (accounts: readonly AccountRecord[]): string | undefined => {
  const [only] = accounts;
  if (only === undefined) return undefined;
  if (accounts.length === 1) return SIGN_IN_AGAIN_LINE[only.status.state as keyof typeof SIGN_IN_AGAIN_LINE](only.label);
  return `${accounts.length} accounts need to sign in again: ${accounts.map((account) => account.label).join(", ")}.`;
};

/** The accounts whose sign-in could not be read, in one line offering Check again (#1836), not Sign in again. */
const unreadableLine = (accounts: readonly AccountRecord[]): string | undefined => {
  const [only] = accounts;
  if (only === undefined) return undefined;
  if (accounts.length === 1) return `agent-harness could not read ${only.label}'s sign-in. Choose Check again.`;
  return `agent-harness could not read the sign-ins of ${accounts.length} accounts: ${accounts.map((account) => account.label).join(", ")}. Choose Check again.`;
};

/** The account Sign in again opens the sign-in of. */
const signInAgain = (account: AccountRecord): SetupTarget => ({ action: "sign-in-again", kind: "account", id: account.id, label: account.label });

/** At least one account is on the environment. */
const accountPresent = (accounts: readonly AccountRecord[]): StateCheckAnswer =>
  accounts.length > 0 || { reason: "No Claude account yet. Sign in to start." };

/**
 * Every account is signed in. Those that are not make one line, in the
 * store's order, with a Sign in again for each; those whose status could not
 * be read make another, with Check again and each read's error in details.
 */
const everySignedIn = (accounts: readonly AccountRecord[]): StateCheckAnswer => {
  const lapsed = accounts.filter((account) => account.status.state === "signed-out" || account.status.state === "expired");
  const unreadable = accounts.filter((account) => account.status.state === "unreadable");
  const lines = [signInAgainLine(lapsed), unreadableLine(unreadable)].filter((line) => line !== undefined);
  if (lines.length === 0) return true;
  const actions: SetupAction[] = [...(lapsed.length > 0 ? ["sign-in-again" as const] : []), ...(unreadable.length > 0 ? ["check-again" as const] : [])];
  const details = unreadable.flatMap((account) => (account.status.detail === null ? [] : [`${account.label}: ${account.status.detail}`]));
  return { reason: lines.join(" "), details, ...(lapsed.length > 0 && { targets: lapsed.map(signInAgain) }), actions };
};

export const accountStateChecks = ({ accounts }: AccountStateChecksOptions): { readonly [Id in AccountStateCheckId]: StateChecker } => ({
  "account.present": () => accountPresent(accounts()),
  "account.signed-in": () => everySignedIn(accounts()),
});

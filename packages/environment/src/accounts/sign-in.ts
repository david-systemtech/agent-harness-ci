import type { AccountRecord, SignInStart } from "@agent-harness/contracts";

/**
 * The sign-in seam (claude-adapter spec, "Sign-in and status through the
 * bundled binary"; ADR 0018): what `accounts.add` hands a new owned account
 * to. The director that drives the bundled binary's `auth login`, publishes
 * the verification URL and takes the code from any client is #135's; this
 * ticket leaves the seam and a preset that says sign-in is not built yet.
 *
 * The director reports the end of a sign-in through the port: the account
 * store then reads the account's status, and it is there, where the
 * identity is reported, that one identity is one account: a sign-in that
 * yields an identity another account holds is refused, "already added as
 * <label>", and the new account is removed and its directory deleted.
 */

/** How a sign-in ended, as the account store found it once the director said it was done. */
export type SignInOutcome =
  | { readonly signedIn: true; readonly account: AccountRecord }
  | {
      readonly signedIn: false;
      /**
       * `identity_held`: another account holds the identity, and this one was
       * removed with its directory; `not_signed_in`: the status read found it
       * signed out, expired or unreadable; `account_gone`: the account was
       * removed meanwhile.
       */
      readonly reason: "identity_held" | "not_signed_in" | "account_gone";
      readonly message: string;
    };

/** What the account store gives the director: where to say a sign-in is done. */
export interface SignInPort {
  /** The provider has signed the account's directory in: its status is read now, and the identity rule applied. */
  finished(accountId: string): Promise<SignInOutcome>;
}

/** The sign-in director: one per environment. */
export interface SignInDirector {
  /** Whether a sign-in for `account` can start, and what to tell a person when it cannot: what `accounts.add` answers. */
  ready(account: Pick<AccountRecord, "id" | "provider" | "directory">): SignInStart;
  /** Starts the account's sign-in once `accounts.add` has committed, when `ready` said it could. */
  start(account: AccountRecord): void;
}

/** How the environment makes its director, handing it the port. */
export type SignInDirectorFactory = (port: SignInPort) => SignInDirector;

/** The preset until #135: nothing starts, and `accounts.add` says so, naming the directory a person can sign in by hand. */
export const signInNotBuilt: SignInDirectorFactory = () => ({
  ready: (account) => ({
    started: false,
    message: `Signing in from the environment is not built yet (#135). The account's directory is ${account.directory.path}; sign it in with the provider's own CLI there, then call accounts.refresh.`,
  }),
  start: () => undefined,
});

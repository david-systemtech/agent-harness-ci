import type { AccountRecord, SignIn, SignInFallback, SignInStart } from "@agent-harness/contracts";
import type { CommandAnswer, CommandContext } from "../serve/methods.js";

/**
 * The sign-in seam (claude-adapter spec, "Sign-in and status through the
 * bundled binary"; ADR 0018): what the account store hands an account to,
 * and what the `accounts.signin.*` methods drive. The director
 * (`signin-director.ts`) runs one sign-in per environment through the
 * provider's own CLI, publishes the verification URL and takes the code from
 * any client; the harness never sees a credential.
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

/** What the account store gives the director. */
export interface SignInPort {
  /** The provider has signed the account's directory in: its status is read now, and the identity rule applied. */
  finished(accountId: string): Promise<SignInOutcome>;
  /** The account as the store holds it now, in the caller's transaction when there is one; null when it is not held. */
  account(accountId: string): AccountRecord | null;
}

/** How a sign-in command is refused: an account the environment does not hold, or the sign-in's rules. */
export type SignInRefusal = "not_found" | "conflict";

/** What a sign-in command answers: the sign-in as the command left it. */
export type SignInAnswer = CommandAnswer<{ signIn: SignIn }, SignInRefusal>;

/** The sign-in director: one per environment, one sign-in at a time. */
export interface SignInDirector {
  /** Whether a sign-in for `account` can start, and what to tell a person when it cannot: what `accounts.add` answers. */
  ready(account: Pick<AccountRecord, "id" | "provider" | "label" | "directory">): SignInStart;
  /** Starts the account's sign-in once `accounts.add` has committed, when `ready` said it could. */
  start(account: AccountRecord): void;
  /** `accounts.signin.start`, inside the command's transaction; the process starts once it has committed. */
  begin(params: { readonly accountId: string }, context: CommandContext): SignInAnswer;
  /** `accounts.signin.code`: the code goes to the process once the command has committed. */
  code(params: { readonly accountId: string; readonly code: string }, context: CommandContext): SignInAnswer;
  /** `accounts.signin.cancel`: the process is stopped once the command has committed. */
  cancel(params: { readonly accountId: string }, context: CommandContext): SignInAnswer;
  /** The latest sign-in since the environment started, running or ended (`accounts.signin.get`). */
  latest(): SignIn | null;
  /** The account was removed: a sign-in of it that is still running is cancelled. */
  removed(accountId: string): void;
  /** Stops a running sign-in's process and its timer, noticing nothing: the environment is closing. */
  close(): void;
}

/** How the environment makes its director, handing it the port. */
export type SignInDirectorFactory = (port: SignInPort) => SignInDirector;

/** What a probe of an executable found: how it exited and what it printed. */
export interface ProbeResult {
  /** Null when it could not be run, or was killed at the probe's timeout. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * How one provider's CLI signs an account's directory in, which the
 * director drives without knowing the provider: Claude's is
 * `adapters/claude/signin.ts`.
 */
export interface SignInProgram {
  /** The provider's binary the SDK ships, which runs use too, and sign-ins run first; null when this platform has none. */
  readonly bundled: string | null;
  /** The managed tool (ADR 0026): the Managed tools registry's row for the provider's CLI, outside the harness's own files; null when there is none. */
  managedTool(): string | null | Promise<string | null>;
  /** The argv that starts a sign-in (`auth login`): never one that picks Console billing. */
  readonly argv: readonly string[];
  /** The argv that asks an executable whether it runs a sign-in. */
  readonly probeArgv: readonly string[];
  /** Whether the probe's answer says the executable runs a sign-in. */
  runsSignIn(result: ProbeResult): boolean;
  /** The process environment for a sign-in of `directory`: the host's, scrubbed, with the directory variable set. */
  env(directory: string): Record<string, string>;
  /** The verification URL, once the output so far holds a whole one; null until then. */
  verificationUrl(output: string): string | null;
  /** The command a person runs in a terminal on the environment's machine instead, the directory quoted. */
  fallback(directory: string, executable: string): SignInFallback;
  /** The executable a fallback names before one has been chosen and none is bundled: the managed tool's name. */
  readonly toolName: string;
}

const unavailable = (aggregate: { readonly kind: string; readonly id: string }, reason: string, message: string): SignInAnswer => ({
  aggregate,
  rejected: { code: "conflict", message, data: { reason } },
});

/**
 * The preset of an account store made without a director (a lower-seam
 * test): nothing starts, and `accounts.add` says so, naming the directory a
 * person can sign in by hand. The environment itself runs the real director.
 */
export const signInUnavailable: SignInDirectorFactory = () => {
  const stream = (accountId: string) => ({ kind: "account", id: accountId });
  return {
    ready: (account) => ({
      started: false,
      reason: "signin_unavailable",
      message: `Signing in from this environment is not available. The account's directory is ${account.directory.path}; sign it in with the provider's own CLI there, then check the account again.`,
    }),
    start: () => undefined,
    begin: ({ accountId }) => unavailable(stream(accountId), "signin_unavailable", "Signing in from this environment is not available."),
    code: ({ accountId }) => unavailable(stream(accountId), "not_awaiting_code", "No sign-in is awaiting a code."),
    cancel: ({ accountId }) => unavailable(stream(accountId), "no_signin", "No sign-in of this account is running."),
    latest: () => null,
    removed: () => undefined,
    close: () => undefined,
  };
};

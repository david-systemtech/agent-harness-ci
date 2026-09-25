import type { AccountRecord } from "@agent-harness/contracts";
import type { SignInDirectorFactory, SignInOutcome, SignInPort } from "../src/accounts/sign-in.js";

/**
 * A scripted sign-in director (#135's seam, filled for the tests of #134):
 * it says a sign-in starts, records each account it is handed, and lets the
 * test say when the provider has signed the directory in (`finish`), which
 * the account store answers with the status read and the identity rule.
 * What the directory is signed in as is the fake adapter's status probe.
 */
export interface ScriptedSignIn {
  readonly factory: SignInDirectorFactory;
  /** The accounts handed to the director, in order. */
  readonly started: readonly AccountRecord[];
  /** The provider signed `accountId`'s directory in: the store's answer. */
  finish(accountId: string): Promise<SignInOutcome>;
}

export const scriptedSignIn = (): ScriptedSignIn => {
  const started: AccountRecord[] = [];
  let port: SignInPort | undefined;
  return {
    factory: (given) => {
      port = given;
      return { ready: () => ({ started: true, message: null }), start: (account) => void started.push(account) };
    },
    started,
    finish: (accountId) => {
      if (port === undefined) throw new Error("The scripted sign-in was never handed to an environment.");
      return port.finished(accountId);
    },
  };
};

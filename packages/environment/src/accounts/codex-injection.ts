import type { AccountRecord, CodexForClaudeRuns } from "@agent-harness/contracts";
import type { ProcessEnvironmentScope, ProcessEnvironmentSupplier } from "../adapter/process-environment.js";
import { CODEX_HOME, CODEX_PROVIDER, CODEX_WORKER_HOME } from "../adapters/codex/constants.js";

/**
 * A Codex account injected into Claude runs (#2169; ADR 0011's injection
 * pattern, ADR 0018): the Codex account chosen for Claude runs, by the
 * `accounts.codexForClaudeRuns` setting, gives each Claude run's provider
 * process its directory as `CODEX_HOME` and `CODEX_WORKER_HOME`, so the
 * run's commands can call `codex` signed in as it. The directory is the
 * process environment's writable directory for the holder, which a
 * contained run's sandbox lets its commands write (codex keeps its sessions
 * and refreshed login there, #1119), and the environment exempts it from
 * the denylist's data-directory preset as it does the key-manager CLI's
 * (#368), so a contained run's codex can read it.
 *
 * Like every supplier's, its part is given only while the holder's
 * credential injection answer allows (`process-environment.ts`), and its
 * key, the directory's path (never a secret), changes when the chosen
 * account does, so a run after the change gets a fresh process.
 */

/** The name the Codex account's supplier registers under. */
export const CODEX_SUPPLIER = "codex-account";

/** What the chooser reads of an account: its id, provider, directory and status. */
export type CodexCandidate = Pick<AccountRecord, "id" | "provider" | "directory" | "status">;

const signedInCodex = (account: CodexCandidate): boolean => account.provider === CODEX_PROVIDER && account.status.state === "signed-in";

/**
 * The Codex account Claude runs get (`accounts.codexForClaudeRuns`): the
 * one the setting names while the environment holds it signed in; with the
 * setting unset, the only signed-in Codex account when there is exactly
 * one; otherwise, or with the setting off (`false`), none.
 */
export const chooseCodexAccount = <Account extends CodexCandidate>(accounts: readonly Account[], setting: CodexForClaudeRuns): Account | null => {
  if (setting === false) return null;
  if (setting !== null) return accounts.find((account) => account.id === setting && signedInCodex(account)) ?? null;
  const signedIn = accounts.filter(signedInCodex);
  return signedIn.length === 1 ? (signedIn[0] ?? null) : null;
};

/** The chosen account's directory, as the run's `CODEX_HOME`; null for none. */
export const codexHomeOf = (accounts: readonly CodexCandidate[], setting: CodexForClaudeRuns): string | null => chooseCodexAccount(accounts, setting)?.directory.path ?? null;

/** The variables a Claude run is given for the Codex directory `home`: `CODEX_HOME` and `CODEX_WORKER_HOME`, both naming it. */
export const codexVariables = (home: string): Readonly<Record<string, string>> => ({ [CODEX_HOME]: home, [CODEX_WORKER_HOME]: home });

/** A Claude run's provider process: the only holder the Codex account is given to (not a terminal, a pre-check or a verify command). */
export const servesClaudeRun = (scope: ProcessEnvironmentScope): boolean => scope.holder === "provider-process";

export interface CodexSupplierOptions {
  /** The chosen Codex account's directory, read as each holder is built and at each spawn; null for none. */
  readonly codexHome: () => string | null;
  /** Whether `scope` is a holder the account is given to; preset: `servesClaudeRun`. */
  readonly serves?: (scope: ProcessEnvironmentScope) => boolean;
}

/**
 * The process-environment supplier that gives a Claude run the chosen Codex
 * account: its key is the directory, empty for a holder it does not serve
 * or with no account chosen; its supply the two variables and the directory
 * as the holder's writable one, nothing to release (the directory is the
 * account's, never the holder's).
 */
export const createCodexSupplier = (options: CodexSupplierOptions): ProcessEnvironmentSupplier => {
  const serves = options.serves ?? servesClaudeRun;
  const homeFor = (scope: ProcessEnvironmentScope): string | null => (serves(scope) ? options.codexHome() : null);
  return {
    name: CODEX_SUPPLIER,
    key: (scope) => homeFor(scope) ?? "",
    supply: (scope) => {
      const home = homeFor(scope);
      return home === null ? { variables: {}, release: () => undefined } : { variables: codexVariables(home), writable: [home], release: () => undefined };
    },
  };
};

/** The directories the denylist leaves out for the chosen Codex account: its directory, or none. */
export const codexExempt = (codexHome: () => string | null): string[] => {
  const home = codexHome();
  return home === null ? [] : [home];
};

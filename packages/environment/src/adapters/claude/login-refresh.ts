import type { Clock } from "../../serve/clock.js";

/**
 * An account's login made usable before a cold resume through the session
 * store (claude-adapter spec, #229's notes). The pinned SDK (0.3.281)
 * resumes a stored session by writing it into a temporary config directory
 * and copying the account's `.credentials.json` there with
 * `claudeAiOauth.refreshToken` deleted, without refreshing first; it has no
 * option that keeps the refresh token. So before every such resume the
 * adapter has the CLI refresh the login in the account's own directory: an
 * unsampled query there (`control-query.ts`) asks the usage read, which the
 * bundled 2.1.281 makes with its OAuth refresh on (a token within five
 * minutes of its expiry is refreshed first, a 401 refreshed and retried),
 * and the query's answer says whether the login works.
 *
 * The harness reads no credential file (ADR 0018: it holds no Claude
 * credential, and an adopted directory is read only by the provider's own
 * CLI), so it cannot tell a fresh login from an expired one beforehand: the
 * query runs before every cold resume through the store, at the cost of one
 * CLI start. Concurrent resumes of one account share the query in flight, so
 * two sessions resuming together refresh once; a later query finds the login
 * fresh and the CLI refreshes nothing, and a refresh token another process
 * rotated is taken under the CLI's own lock, never offered again.
 *
 * Only a login failure (the usage read refused as unauthorised, the refresh
 * token refused) stops the run and marks the directory lapsed. A query that
 * could not tell (no usage method in this SDK build, a CLI that did not
 * start or answer, any other failure) lets the run go on: its CLI reads the
 * account's own credential store (`CLAUDE_SECURESTORAGE_CONFIG_DIR`,
 * `credentials.ts`) and refreshes there itself.
 *
 * The marking is in memory: after a restart the account reads as its status
 * command says until a cold resume fails again.
 */

/** The run error code of a cold resume whose account's login could not be refreshed. */
export const LOGIN_EXPIRED_CODE = "login_expired";

/** How long after a lapsed login was last tried a status read tries it again, behind its answer: never the read that follows the failure at once. */
export const LAPSED_RETRY_MS = 60 * 1000;

/** What the refresh query came to. */
export type RefreshOutcome =
  /** The usage read answered: the login works, refreshed first if it was due. */
  | { readonly kind: "usable" }
  /** The CLI could not authenticate, its refresh included: the login has lapsed. */
  | { readonly kind: "login-failed"; readonly detail: string }
  /** The query could not tell (no usage method, no CLI, no answer, another failure): the run's own CLI is left to refresh. */
  | { readonly kind: "not-run"; readonly detail: string };

/**
 * How the bundled 2.1.281 words a usage read it could not authenticate:
 * `Auth error: <reason or detail>` (the usage fetch's own), the refresh
 * token's refusal (`invalid_grant`, "no longer valid; run /login to
 * re-authenticate"), a 401, or no login at all.
 */
const LOGIN_FAILURE = /\bauth(entication)? error\b|\b401\b|unauthori[sz]ed|invalid_grant|re-?authenticate|\/login\b|not logged in|no claude\.ai login/i;

/** Whether a failed usage read's message says the login cannot authenticate, as against any other failure. */
export const isLoginFailure = (message: string): boolean => LOGIN_FAILURE.test(message);

/** The account's login has lapsed and could not be refreshed: the run cannot start signed in. */
export class LoginLapsed extends Error {
  override readonly name = "LoginLapsed";
  constructor(accountName: string, detail: string) {
    super(`The Claude account ${accountName} has an expired login that could not be refreshed before resuming the session (${detail}); sign in to it again.`);
  }
}

export interface LoginRefresher {
  /**
   * Runs the refresh query for the directory, or waits for the one in
   * flight. Resolves when the login is usable or the query could not tell;
   * rejects with `LoginLapsed`, naming the account, when the login failed,
   * and the directory is lapsed until a refresh succeeds or a sign-in
   * replaces the login.
   */
  beforeResume(directory: string, accountName: string): Promise<void>;
  /**
   * Whether the directory is lapsed. When it is, and it was last tried
   * `LAPSED_RETRY_MS` ago or more, the refresh is tried again behind the
   * answer, so one that failed for a passing reason clears itself.
   */
  lapsed(directory: string): boolean;
  /** A sign-in replaced the directory's login: the lapse no longer holds. */
  forget(directory: string): void;
}

export interface LoginRefresherOptions {
  readonly clock: Pick<Clock, "now">;
  /** Runs the refresh query in the directory. Never rejects: a query that throws could not tell. */
  readonly refresh: (directory: string) => Promise<RefreshOutcome>;
  readonly diagnostic: (message: string) => void;
}

export const createLoginRefresher = (options: LoginRefresherOptions): LoginRefresher => {
  const now = (): number => options.clock.now().getTime();
  /** The query in flight per directory, which a second caller waits for rather than starting its own. */
  const running = new Map<string, Promise<RefreshOutcome>>();
  /** Lapsed directories, and when each was last tried. */
  const lapses = new Map<string, number>();

  const attempt = (directory: string): Promise<RefreshOutcome> => {
    const inFlight = running.get(directory);
    if (inFlight !== undefined) return inFlight;
    const query = options
      .refresh(directory)
      .catch((error: unknown): RefreshOutcome => ({ kind: "not-run", detail: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        if (outcome.kind === "usable") lapses.delete(directory);
        // Tried again: a lapsed directory stays lapsed until a query says the login works.
        else if (outcome.kind === "login-failed" || lapses.has(directory)) lapses.set(directory, now());
        return outcome;
      })
      .finally(() => running.delete(directory));
    running.set(directory, query);
    return query;
  };

  return {
    async beforeResume(directory, accountName) {
      const outcome = await attempt(directory);
      if (outcome.kind === "login-failed") throw new LoginLapsed(accountName, outcome.detail);
      if (outcome.kind === "not-run") {
        options.diagnostic(`Claude: the login of the account ${accountName} could not be checked before a resume (${outcome.detail}); the run's CLI refreshes it from the account's own credential store.`);
      }
    },
    lapsed(directory) {
      const triedAt = lapses.get(directory);
      if (triedAt === undefined) return false;
      if (now() - triedAt >= LAPSED_RETRY_MS && !running.has(directory)) void attempt(directory);
      return true;
    },
    forget(directory) {
      lapses.delete(directory);
    },
  };
};

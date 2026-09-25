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
 * minutes of its expiry is refreshed first, a 401 refreshed and retried).
 *
 * The verdict is read from the CLI, never from a credential file (ADR 0018:
 * the harness holds no Claude credential, and an adopted directory is read
 * only by the provider's own CLI). The usage read answers whether or not the
 * fetch behind it authenticated (2.1.281 catches the fetch's failure and
 * answers `rate_limits: null`), so an answer carrying the plan's limits is a
 * usable login, and anything else is settled by the status command: a
 * refresh the provider refused makes the CLI clear the stored login, so a
 * status that says signed out is a lapsed login; one that still says signed
 * in could not tell (no network, a rate limit, a CLI that did not answer),
 * and the run goes on, its CLI refreshing from the account's own credential
 * store (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, `credentials.ts`).
 *
 * Concurrent resumes of one account share the query in flight, so two
 * sessions resuming together refresh once; a later resume runs its own,
 * which finds the login fresh, and a refresh token another process rotated
 * is taken under the CLI's own lock, never offered again.
 *
 * A lapsed directory reads `expired` rather than the signed out its status
 * command says, until the command says signed in again (a sign-in, from the
 * harness or the provider's own CLI). The marking is in memory: after a
 * restart the account reads signed out.
 */

/** The run error code of a cold resume whose account's login could not be refreshed. */
export const LOGIN_EXPIRED_CODE = "login_expired";

/** What the refresh query came to. */
export type RefreshOutcome =
  /** The usage read reached the plan's limits: the login works, refreshed first if it was due. */
  | { readonly kind: "usable" }
  /** The CLI signed the account out: the provider refused the login's refresh, or there was no login. */
  | { readonly kind: "login-failed"; readonly detail: string }
  /** The query could not tell (no usage method, no CLI, no answer, no limits reached while still signed in): the run's own CLI is left to refresh. */
  | { readonly kind: "not-run"; readonly detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether a usage read's answer carries the plan's limits, which only a fetch that authenticated reaches (as `plan-usage.ts` reads them). */
export const reachedPlanLimits = (response: unknown): boolean => isRecord(response) && response["rate_limits_available"] === true && isRecord(response["rate_limits"]);

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
   * and the directory is lapsed until its status says signed in again.
   */
  beforeResume(directory: string, accountName: string): Promise<void>;
  /** Whether the last query found the directory's login lapsed, and no status has read it signed in since. */
  lapsed(directory: string): boolean;
  /** The directory's status reads signed in: the lapse no longer holds. */
  signedIn(directory: string): void;
}

export interface LoginRefresherOptions {
  /** Runs the refresh query in the directory. Never rejects: a query that throws could not tell. */
  readonly refresh: (directory: string) => Promise<RefreshOutcome>;
  readonly diagnostic: (message: string) => void;
}

export const createLoginRefresher = (options: LoginRefresherOptions): LoginRefresher => {
  /** The query in flight per directory, which a second caller waits for rather than starting its own; gone once it settles. */
  const running = new Map<string, Promise<RefreshOutcome>>();
  const lapses = new Set<string>();

  const attempt = (directory: string): Promise<RefreshOutcome> => {
    const inFlight = running.get(directory);
    if (inFlight !== undefined) return inFlight;
    const query = options
      .refresh(directory)
      .catch((error: unknown): RefreshOutcome => ({ kind: "not-run", detail: error instanceof Error ? error.message : String(error) }))
      .then((outcome) => {
        if (outcome.kind === "usable") lapses.delete(directory);
        else if (outcome.kind === "login-failed") lapses.add(directory);
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
    lapsed: (directory) => lapses.has(directory),
    signedIn(directory) {
      lapses.delete(directory);
    },
  };
};

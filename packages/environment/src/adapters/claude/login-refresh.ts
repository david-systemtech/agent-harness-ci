import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../serve/clock.js";
import type { ConfigDirQueue } from "./config-dir-queue.js";

/**
 * An account's expired login, refreshed before a cold resume through the
 * session store (claude-adapter spec, #229's notes). The pinned SDK
 * (0.3.281) resumes a stored session by writing it into a temporary config
 * directory and copying the account's `.credentials.json` there with
 * `claudeAiOauth.refreshToken` deleted, without refreshing first; it has no
 * option that keeps the refresh token. So the adapter makes the stored login
 * fresh in the account's own directory before such a resume spawns: when the
 * stored access token is past its expiry, or inside the CLI's own
 * five-minute margin, an unsampled query under the account's directory
 * (`control-query.ts`) asks the usage read, which the bundled 2.1.281 makes
 * with its OAuth refresh on; the CLI refreshes the login in place, and the
 * adapter reads the expiry again to know it did.
 *
 * Once per account: a refresh runs under the config-directory queue (#121),
 * and a resume that asks while one of its account runs waits for that one;
 * the expiry is read again once the queue reaches it, so a refresh finished
 * meanwhile is not repeated. A rotated refresh token is never offered twice.
 *
 * The harness reads the expiry and nothing else of the file (ADR 0018: it
 * holds no Claude credential); a login it cannot read (no file, as on macOS,
 * where the login is in the keychain; no expiry) is left to the CLI, whose
 * credential store is the account's own directory on every process
 * (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, `credentials.ts`).
 */

/** The file the bundled CLI keeps a subscription login in, in its credential store's directory. */
export const CREDENTIALS_FILE = ".credentials.json";

/** How close to its expiry a stored access token is refreshed: the bundled 2.1.281's own margin, five minutes. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The run error code of a cold resume whose account's login could not be refreshed. */
export const LOGIN_EXPIRED_CODE = "login_expired";

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The stored access token's expiry (ms since the epoch), from the directory's credentials file; null when there is none to read. */
export const storedExpiry = (directory: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, CREDENTIALS_FILE), "utf8"));
  } catch {
    return null;
  }
  const login = isRecord(parsed) ? parsed["claudeAiOauth"] : undefined;
  const expiresAt = isRecord(login) ? login["expiresAt"] : undefined;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : null;
};

/** Whether a login expiring at `expiresAt` is due a refresh at `now`: past it or inside the margin. An unknown expiry is not. */
export const dueRefresh = (expiresAt: number | null, now: number): boolean => expiresAt !== null && now + REFRESH_MARGIN_MS >= expiresAt;

/** The account's login is past its expiry and could not be refreshed: the run cannot start signed in. */
export class LoginLapsed extends Error {
  override readonly name = "LoginLapsed";
  constructor(
    readonly accountId: string,
    detail: string,
  ) {
    super(`The Claude account ${accountId} has an expired login that could not be refreshed before resuming the session (${detail}); sign in to it again.`);
  }
}

export interface LoginRefresher {
  /**
   * Makes the directory's stored login fresh: nothing when it is fresh, or
   * cannot be read; else one refresh, shared with any other caller for the
   * directory, under the queue. Rejects with `LoginLapsed` when the login is
   * still due a refresh afterwards, and the directory is lapsed until a
   * later call finds or makes it fresh.
   */
  ensureFresh(directory: string, accountId: string): Promise<void>;
  /** Whether the last refresh of the directory failed, and nothing has found it fresh since. */
  lapsed(directory: string): boolean;
}

export interface LoginRefresherOptions {
  readonly clock: Pick<Clock, "now">;
  /** The config-directory queue the refreshes run under, one at a time. */
  readonly queue: ConfigDirQueue;
  /** Has the CLI refresh the directory's login in place; its verdict is the expiry read afterwards, not its answer. */
  readonly refresh: (directory: string) => Promise<void>;
  /** Reads a directory's stored expiry; preset: its credentials file. */
  readonly readExpiry?: (directory: string) => number | null;
}

export const createLoginRefresher = (options: LoginRefresherOptions): LoginRefresher => {
  const readExpiry = options.readExpiry ?? storedExpiry;
  const due = (directory: string): boolean => dueRefresh(readExpiry(directory), options.clock.now().getTime());
  /** The refresh in flight per directory, which a second caller waits for rather than starting its own. */
  const running = new Map<string, Promise<void>>();
  const lapsed = new Set<string>();

  const refreshOnce = (directory: string, accountId: string): Promise<void> =>
    options.queue.run(directory, async () => {
      // Read again once the queue reaches it: a refresh that finished while this one waited leaves nothing to do.
      if (!due(directory)) return;
      let failure: string | null = null;
      try {
        await options.refresh(directory);
      } catch (error) {
        failure = describe(error);
      }
      if (due(directory)) throw new LoginLapsed(accountId, failure ?? "the provider's CLI answered, and the stored login is still past its expiry");
    });

  return {
    ensureFresh(directory, accountId) {
      if (!due(directory)) {
        lapsed.delete(directory);
        return Promise.resolve();
      }
      const inFlight = running.get(directory);
      if (inFlight !== undefined) return inFlight;
      const attempt = refreshOnce(directory, accountId)
        .then(
          () => void lapsed.delete(directory),
          (error: unknown) => {
            lapsed.add(directory);
            // The queue refusing the call (it waited out its time) is a refresh that did not happen either.
            throw error instanceof LoginLapsed ? error : new LoginLapsed(accountId, describe(error));
          },
        )
        .finally(() => running.delete(directory));
      running.set(directory, attempt);
      return attempt;
    },
    lapsed: (directory) => lapsed.has(directory),
  };
};

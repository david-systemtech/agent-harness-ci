/**
 * Sign-in through the bundled binary (claude-adapter spec, "Sign-in and
 * status through the bundled binary"; ADR 0018): the argv the credential spec
 * carries, and nothing more. The sign-in director that spawns `auth login`,
 * publishes the verification URL and takes the code back from a client is
 * #135's; it runs these with `CLAUDE_CONFIG_DIR` at the account's directory
 * and the stripped variables absent, as every Claude process runs.
 *
 * Subscription only: `--console` is never passed. A Console user runs the
 * fallback command with it (ADR 0018). `--claudeai` is not passed either: it
 * restates the binary's default in a line a person may read and paste.
 */

/** Starts a sign-in: the binary prints a verification URL and reads the code on stdin. */
export const CLAUDE_LOGIN_ARGV = ["auth", "login"] as const;

/** Prints the account's sign-in state as JSON; exits 1 when signed out, still printing it. */
export const CLAUDE_STATUS_ARGV = ["auth", "status", "--json"] as const;

/** Clears the credential from the account's directory. */
export const CLAUDE_LOGOUT_ARGV = ["auth", "logout"] as const;

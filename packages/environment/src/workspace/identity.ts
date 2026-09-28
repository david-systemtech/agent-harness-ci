import { repositoryIdentityOf, type ForgeAccountOrigins } from "@agent-harness/contracts";
import { runGit } from "./git.js";

/**
 * A workspace's repository identity (workspace-picker spec, "Repository
 * identity"; #324). The repository is the innermost one holding the
 * workspace path, as git finds it from there: a subdirectory's checkout, a
 * monorepo root, a submodule's own; a worktree reads its checkout's
 * remotes. Its remote is `origin`, else the only one, else the first by
 * name, read as git expands it (`insteadOf` applied), and the contracts'
 * rule (`repositoryIdentityOf`) turns that into the identity.
 *
 * It asks git once, `git remote --verbose`, through the hardened runner
 * (#124): hooks pointed at nothing, the fsmonitor off, a scrubbed
 * environment, no prompts, 15 seconds. A path in no repository, a
 * repository with no remote, and a git that is missing, fails or times out
 * all give none, never a refusal; what git printed is never logged, since a
 * remote's URL can hold a token.
 */

/** The most of `git remote --verbose` read: far more than any repository's remotes. */
const REMOTES_BYTES = 1024 * 1024;

/** A fetch line of `git remote --verbose`: the remote's name, a tab, its first URL as git expands it, then ` (fetch)`. */
const FETCH_LINE = /^([^\t]+)\t(.*) \(fetch\)$/;

/** Each remote's URL by name, from `git remote --verbose`; a remote with no URL has no fetch line and is left out. */
const remotesIn = (listing: string): Map<string, string> => {
  const remotes = new Map<string, string>();
  for (const line of listing.split(/\r?\n/)) {
    const [, name, url] = FETCH_LINE.exec(line) ?? [];
    if (name !== undefined && url !== undefined && !remotes.has(name)) remotes.set(name, url);
  }
  return remotes;
};

/** The URL of the remote an identity comes from: `origin`, else the only one, else the first by name. */
const chosenRemote = (remotes: ReadonlyMap<string, string>): string | undefined => {
  if (remotes.has("origin")) return remotes.get("origin");
  const [first] = [...remotes.keys()].sort();
  return first === undefined ? undefined : remotes.get(first);
};

export interface RepositoryIdentityOptions {
  /** This environment's forge accounts, each with its canonical origin and verified aliases, which the rule maps an alias's host by. */
  readonly forgeAccounts: readonly ForgeAccountOrigins[];
  /** How long git gets; preset: the hardened runner's 15 seconds. */
  readonly timeoutMs?: number;
}

/** The repository identity of the workspace at `path`, or null for none. Never throws. */
export const readRepositoryIdentity = async (path: string, options: RepositoryIdentityOptions): Promise<string | null> => {
  const answer = await runGit(path, ["remote", "--verbose"], { maxBytes: REMOTES_BYTES, ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }) });
  // A git stopped at the timeout or the cap may have listed only some remotes, `origin` perhaps not among them.
  if (!answer.ok || answer.truncated) return null;
  const remote = chosenRemote(remotesIn(answer.stdout.toString("utf8")));
  return remote === undefined ? null : repositoryIdentityOf(remote, options.forgeAccounts);
};

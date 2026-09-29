import { runGit } from "../workspace/git.js";

/**
 * The branch a session's workspace is on, as a run's end looks for its pull
 * requests (forge spec, "Pull-request links and status"; #317): the branch
 * `HEAD` names, and the remote its pull requests are on, which is its
 * upstream's remote, else `origin`. With an upstream on a remote, the head
 * a pull request names is the upstream's branch there, which may be named
 * otherwise than the local one; an upstream that is a local branch (remote
 * `.`) is none.
 *
 * git is asked three times through the hardened runner (#124: hooks
 * pointed at nothing, the fsmonitor off, a scrubbed environment, no
 * prompts): `symbolic-ref` for the branch, `for-each-ref` for its
 * upstream's remote and branch, read from the branch's configuration alone,
 * and `remote get-url` for the remote's URL as git expands it (`insteadOf`
 * applied). A detached head, a path in no repository, a remote that is not
 * there and a git that fails all give none; what git printed is never
 * logged, since a remote's URL can hold a token.
 */

/** The workspace's branch as its pull requests name it, and the URL of the remote they are on. */
export interface WorkspaceBranch {
  /** The branch a pull request's head names: the upstream's on its remote, else the local one. */
  readonly branch: string;
  /** The remote's URL, as git expands it. */
  readonly remote: string;
}

/** The most of a ref's or a URL's line read: far more than any. */
const LINE_BYTES = 64 * 1024;

const BRANCH_REF = "refs/heads/";

/** The branch the workspace at `path` is on and its remote's URL; null for none. Never throws. */
export const readWorkspaceBranch = async (path: string): Promise<WorkspaceBranch | null> => {
  const head = await runGit(path, ["symbolic-ref", "--quiet", "HEAD"], { maxBytes: LINE_BYTES });
  const ref = head.stdout.toString("utf8").trim();
  if (!head.ok || head.truncated || !ref.startsWith(BRANCH_REF)) return null;
  const upstream = await runGit(path, ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", ref], { maxBytes: LINE_BYTES });
  const [remoteName = "", remoteRef = ""] = upstream.ok && !upstream.truncated ? upstream.stdout.toString("utf8").trim().split("\0") : [];
  // A remote's name goes on git's command line: one that reads as an option is none.
  const tracked = remoteName !== "" && remoteName !== "." && !remoteName.startsWith("-") && remoteRef.startsWith(BRANCH_REF);
  const remote = await runGit(path, ["remote", "get-url", tracked ? remoteName : "origin"], { maxBytes: LINE_BYTES });
  const url = remote.stdout.toString("utf8").trim();
  if (!remote.ok || remote.truncated || url === "") return null;
  return { branch: (tracked ? remoteRef : ref).slice(BRANCH_REF.length), remote: url };
};

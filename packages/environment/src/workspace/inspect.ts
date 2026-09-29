import {
  ContractError,
  WORKSPACES_INSPECT_BRANCH_CAP,
  type InspectedBranch,
  type InspectedCommit,
  type InspectedRepository,
  type WorkspaceInspection,
} from "@agent-harness/contracts";
import { GIT_TIMEOUT_MS, UNTRANSLATED, gitComplaint, runGit, type GitAnswer } from "./git.js";
import type { DirectoryRules } from "./resolver.js";
import { WORKTREE_LIST, listedWorktrees, worktreeRecorder } from "./worktree-listing.js";

/**
 * `workspaces.inspect` (workspace-picker spec, "Browsing an environment's
 * directories"; #331): whether a path would be a usable directory
 * workspace, by the resolver's own rule, with its `problem` when it would
 * not; and, for a usable one in a git repository, what the worktree step
 * needs. Git finds the repository from the path, as it finds a workspace's
 * identity: the innermost holding it.
 *
 * - **Repository**: the root (the top of the worktree holding the path, or
 *   the repository itself where there is no worktree: a bare repository,
 *   or inside a git directory), the main checkout or bare repository a
 *   worktree is made from, and whether it is bare.
 * - **Identity**: the resolver's, so it is the one a session there gets.
 * - **HEAD**: the branch checked out at the path (none when detached), the
 *   commit with its committer date (none before the first commit), and the
 *   branch `origin/HEAD` points at as git last cached it. Nothing is fetched.
 * - **Branches**: the local branches, the most recently committed first
 *   and by name among equals, at most 200, each with the worktree git lists
 *   holding it; one under the worktrees root is named as the environment
 *   records it, with the session whose workspace it is.
 *
 * Every git call goes through the hardened runner (hooks pointed at
 * nothing, the fsmonitor off, a scrubbed environment, no prompts, 15
 * seconds each) and reads refs and the worktree list only: nothing is
 * checked out and no content is compared, so no filter runs, and no `git
 * log` runs, whose configuration can verify a signature with a program the
 * repository names. A path in no repository, or on an environment with no
 * git, has no repository, as it has no identity; git that runs and fails
 * inside one is `conflict`, reason `git_failed`, with its complaint.
 */

export interface InspectOptions {
  /** The environment's resolver's directory rules: the path as recorded, its problem, the identity a session there gets. */
  readonly rules: DirectoryRules;
  /** The data directory's worktrees root, where the worktrees the harness makes are. */
  readonly worktreesRoot: string;
  /** The session whose recorded workspace is the worktree at `path` (as recorded); null for none. */
  readonly sessionAt: (path: string) => string | null;
  /** How long each git call gets; preset: the hardened runner's 15 seconds. */
  readonly timeoutMs?: number;
}

/** The most of a short git answer read: a ref, a path, a line. */
const SMALL_BYTES = 64 * 1024;

/** The most of a listing read: the worktrees, the branches. */
const LISTING_BYTES = 16 * 1024 * 1024;

const BRANCH_PREFIX = "refs/heads/";

/** A ref as the picker names it: a branch without `refs/heads/`, anything else in full. */
const branchName = (ref: string): string => (ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : ref);

/** A commit and the committer date git gave as seconds since the epoch. */
const committed = (commit: string, seconds: string): InspectedCommit => ({ commit, committedAt: new Date(Number(seconds) * 1000).toISOString() });

/** What git printed, less the newline that ends it. */
const printed = (answer: GitAnswer): string => answer.stdout.toString("utf8").replace(/\r?\n$/, "");

/** Git ran and failed, or was stopped: `conflict`, reason `git_failed`, with the line that says why. */
const gitFailed = (line: string): ContractError =>
  new ContractError({ code: "conflict", message: `git could not read the repository: ${line}`, data: { reason: "git_failed" } });

/** The repository holding the usable directory at `path`, with the identity a session there gets; null outside any. */
const describeRepository = async (path: string, options: InspectOptions): Promise<InspectedRepository | null> => {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = (args: readonly string[], maxBytes = SMALL_BYTES): Promise<GitAnswer> => runGit(path, args, { maxBytes, timeoutMs });
  /** What git printed, or the refusal of its failure. */
  const must = (answer: GitAnswer): string => {
    if (answer.ok && !answer.truncated) return printed(answer);
    throw gitFailed(answer.timedOut ? `git did not finish in ${timeoutMs / 1000} s.` : gitComplaint(answer.stderr));
  };
  /** As `must`, but exit 1, a `--quiet` git's "there is none", is null. */
  const mustOrNone = (answer: GitAnswer): string | null => (answer.code === 1 ? null : must(answer));

  // Its complaint read as text: git's own words, untranslated.
  const where = await runGit(path, ["rev-parse", "--is-inside-work-tree"], { maxBytes: SMALL_BYTES, timeoutMs, env: UNTRANSLATED });
  if (where.missing || (!where.ok && /not a git repository/i.test(where.stderr))) return null;
  const inWorktree = must(where) === "true";

  const [listing, top, head, headCommit, originHead, refs, repositoryIdentity, recorded] = await Promise.all([
    git(WORKTREE_LIST, LISTING_BYTES),
    inWorktree ? git(["rev-parse", "--show-toplevel"]) : undefined,
    git(["symbolic-ref", "--quiet", "HEAD"]),
    // `--ignore-missing` answers nothing for an unborn branch; `--` keeps a file named HEAD from being read as a path.
    git(["rev-list", "--no-walk", "--timestamp", "--ignore-missing", "HEAD", "--"]),
    git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    git(
      [
        "for-each-ref",
        `--count=${WORKSPACES_INSPECT_BRANCH_CAP + 1}`,
        // The last key sorts first: the latest commit, then the name.
        "--sort=refname",
        "--sort=-committerdate",
        "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
        BRANCH_PREFIX,
      ],
      LISTING_BYTES,
    ),
    options.rules.identityAt(path),
    worktreeRecorder(options.worktreesRoot),
  ]);

  const worktrees = listedWorktrees(must(listing));
  const [main] = worktrees;
  if (main === undefined) throw gitFailed("git listed no worktrees.");
  // The worktree holding each branch, by its full ref, as git lists it.
  const holders = new Map(worktrees.flatMap(({ path: at, branch }) => (branch === null ? [] : [[branch, at] as const])));
  /** The worktree holding `ref`, one of the harness's as the environment records it with its session; none when it is free. */
  const heldBy = (ref: string): Pick<InspectedBranch, "worktree" | "sessionId"> => {
    const listed = holders.get(ref);
    if (listed === undefined) return { worktree: null, sessionId: null };
    const own = recorded(listed);
    return own === null ? { worktree: listed, sessionId: null } : { worktree: own, sessionId: options.sessionAt(own) };
  };

  const lines = must(refs)
    .split("\n")
    .filter((line) => line !== "");
  const branches = lines.slice(0, WORKSPACES_INSPECT_BRANCH_CAP).flatMap((line): InspectedBranch[] => {
    const [ref = "", commit = "", seconds = ""] = line.split("\0");
    // A branch at anything but a commit has no committer date, and no worktree is made on it.
    return seconds === "" ? [] : [{ name: branchName(ref), ...committed(commit, seconds), ...heldBy(ref) }];
  });
  // `<seconds> <commit>`, or nothing before the first commit.
  const headLine = must(headCommit);
  const [seconds = "", commit = ""] = headLine.split(" ");
  const branch = mustOrNone(head);

  return {
    root: top === undefined ? main.path : must(top),
    mainCheckout: main.path,
    bare: main.bare,
    repositoryIdentity,
    branch: branch === null ? null : branchName(branch),
    head: headLine === "" ? null : committed(commit, seconds),
    originHead: mustOrNone(originHead),
    branches,
    branchesTruncated: lines.length > WORKSPACES_INSPECT_BRANCH_CAP,
  };
};

/** What `workspaces.inspect` answers for the requested path: see the module comment. */
export const inspectPath = async (requested: string, options: InspectOptions): Promise<WorkspaceInspection> => {
  const path = options.rules.recorded(requested);
  const problem = await options.rules.problemWith(path);
  return { path, problem, repository: problem === null ? await describeRepository(path, options) : null };
};

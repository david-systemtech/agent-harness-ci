import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import type { JsonObject } from "../event-log/event-log.js";
import type { Refusal } from "../sessions/decider.js";
import { hashedName, slug } from "./directory-names.js";
import { GIT_TIMEOUT_MS, filtersNamed, gitComplaint, repositoryFilters, runGit, type GitAnswer } from "./git.js";
import { isInside } from "./paths.js";
import type { Resolution } from "./resolver.js";

/**
 * The worktree maker (workspace-picker spec, "The resolver", Worktree;
 * #326): a `worktree` request made into a worktree of the repository holding
 * its path, from the main checkout (or the bare repository), never from
 * another worktree, so a path inside a worktree gives one of its main
 * checkout.
 *
 * - **Branch**: `branch` checks out an existing local branch; otherwise a
 *   new branch is made, named `newBranch.name`, else `agent-harness/` and the
 *   session id's first eight characters, from `newBranch.base` (any ref),
 *   else the main checkout's `HEAD`. Nothing is fetched.
 * - **Place**: under the worktrees root, a directory per repository named
 *   from the checkout's directory name and a short hash of its path (as
 *   auto-memory directories are named, `directory-names.ts`), then one per
 *   branch, suffixed `-2`, `-3` when taken.
 * - **Lock**: added locked, the reason naming the session, so
 *   `git worktree prune` leaves it alone while the session has it.
 * - **Filters**: added with nothing checked out, then the repository's own
 *   filters are read as the new worktree sees them (its branch's
 *   `includeIf` too) and refused as `diffs.workingTree` refuses them (#212),
 *   before `git reset --hard` checks the branch out. No hook runs: the
 *   hardened runner points hooks at nothing (`git.ts`), and setup scripts
 *   are fog (ADR 0005).
 * - **`.worktreeinclude`**: the main checkout's (Claude Code's format:
 *   `.gitignore` patterns, of which only files git ignores count) names the
 *   untracked, ignored files copied in: regular files only, never a link or
 *   through one, never over a file the branch checked out, at most 1,000.
 *
 * Every git call goes through the hardened runner (hooks pointed at
 * nothing, the fsmonitor off, a scrubbed environment, no prompts, 15
 * seconds each). Each refusal is `conflict` with its reason:
 * `not_a_repository`, `git_unavailable`, `no_commits`, `git_filters_refused`
 * (the filters named), `branch_exists`, `branch_not_found`,
 * `branch_checked_out` (naming the worktree and, when it is the harness's,
 * its session), or `git_failed` with git's `fatal:` line. What the maker
 * made for a create it then refuses is removed before it answers, and the
 * answer's `undo` removes the worktree, and the branch this create made
 * while it still points where it was made (it holds no commits), when the
 * create is not accepted; a branch that was there before is never deleted.
 */

/** A worktree request, as `sessions.create` takes one. */
export type WorktreeRequest = Extract<WorkspaceRequest, { kind: "worktree" }>;

export interface WorktreeMakerOptions {
  /** The worktrees root, `<data dir>/worktrees`, as the environment names it. */
  readonly root: string;
  /** The session here whose recorded workspace is the worktree at `path` (as recorded), which a `branch_checked_out` refusal names; null for none. */
  readonly sessionAt: (path: string) => string | null;
  /** The repository identity of the workspace at `path`, the resolver's rule. */
  readonly identityAt: (path: string) => Promise<string | null>;
  /** How long each git call gets; preset: the hardened runner's 15 seconds. */
  readonly timeoutMs?: number;
}

/** The file in the main checkout naming the ignored files a new worktree gets a copy of. */
const WORKTREE_INCLUDE = ".worktreeinclude";

/** The most files `.worktreeinclude` copies into one worktree. */
const MAX_INCLUDED_FILES = 1_000;

/** The most of a short git answer read: a ref, a name, a line. */
const SMALL_BYTES = 64 * 1024;

/** The most of a listing read: the worktrees, the files `.worktreeinclude` names. */
const LISTING_BYTES = 16 * 1024 * 1024;

/** A refusal thrown from a step to the one place that removes what the maker made. */
class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

const refused = (reason: string, message: string, data: JsonObject = {}): Refused =>
  new Refused({ code: "conflict", message, data: { reason, ...data } });

const gitUnavailable = (): Refused => refused("git_unavailable", "There is no git on this environment to make a worktree with.");

/** Git ran and failed, or was stopped: `git_failed` with the line that says why. */
const gitFailed = (line: string): Refused => refused("git_failed", `git could not make the worktree: ${line}`);

/** The refusal of a git call that did not succeed: no git at all, the timeout, or git's own complaint. */
const failure = (answer: GitAnswer, timeoutMs: number): Refused => {
  if (answer.missing) return gitUnavailable();
  if (answer.timedOut) return gitFailed(`git did not finish in ${timeoutMs / 1000} s.`);
  return gitFailed(gitComplaint(answer.stderr));
};

/** One worktree as `git worktree list --porcelain -z` lists it; the first is the main checkout or the bare repository. */
interface ListedWorktree {
  readonly path: string;
  readonly bare: boolean;
  /** The branch checked out, as a full ref; null when detached, or bare. */
  readonly branch: string | null;
}

/** The worktrees in a `--porcelain -z` listing: fields ended by a NUL, each worktree's ended by an empty one. */
const listedWorktrees = (listing: string): ListedWorktree[] => {
  const worktrees: ListedWorktree[] = [];
  let current: { path: string; bare: boolean; branch: string | null } | null = null;
  for (const field of listing.split("\0")) {
    const space = field.indexOf(" ");
    const [key, value] = space === -1 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
    if (key === "worktree") {
      current = { path: value, bare: false, branch: null };
      worktrees.push(current);
    } else if (current !== null && key === "bare") current.bare = true;
    else if (current !== null && key === "branch") current.branch = value;
  }
  return worktrees;
};

/** Names git never checks out as a branch by name (it reads them as `@{-1}` or a commit): no existing local branch is asked for by one. */
const notABranchName = (name: string): boolean => name === "HEAD" || name.startsWith("-");

/** The file errors that skip one `.worktreeinclude` file: gone, a link, unreadable, or a file (or link) already where it would go. */
const SKIPPED = new Set(["ENOENT", "ELOOP", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR"]);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** Opens a file without following a link at its last step; where the platform has no such flag, the `lstat` before it is the check. */
const NO_FOLLOW = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

/**
 * Copies the regular file `file` (relative, forward slashes) from the
 * checkout `from` into the worktree `to`, making its directories there;
 * answers whether it copied. Nothing is followed through a link on either
 * side, and nothing already in the worktree is written over.
 */
const copyInto = async (from: string, to: string, file: string): Promise<boolean> => {
  const segments = file.split("/");
  const name = segments.pop() as string;
  try {
    let directory = to;
    for (const segment of segments) {
      directory = join(directory, segment);
      await mkdir(directory).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      // A link the branch checked out, or a file, where a directory would go.
      if (!(await lstat(directory)).isDirectory()) return false;
    }
    const source = join(from, file);
    if (!(await lstat(source)).isFile()) return false;
    const handle = await open(source, NO_FOLLOW);
    try {
      const { mode } = await handle.stat();
      await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(join(directory, name), { flags: "wx", mode: mode & 0o777 }));
      return true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (SKIPPED.has(errorCode(error) ?? "")) return false;
    throw error;
  }
};

/** The directory to ask git from for a request's path: the path itself, or the directory holding a file; null when nothing is there. */
const startingDirectory = async (path: string): Promise<string | null> => {
  try {
    return (await stat(path)).isDirectory() ? path : dirname(path);
  } catch {
    return null;
  }
};

/** Claims the worktree's directory under `root`: made empty here, so no other create takes it; git adds the worktree into it. */
const claimDirectory = async (root: string, repository: string, branch: string): Promise<string> => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = join(root, hashedName(basename(repository), repository, "repository"));
  await mkdir(parent, { recursive: true });
  const name = slug(branch, "branch");
  for (let n = 1; ; n += 1) {
    const candidate = join(parent, n === 1 ? name : `${name}-${n}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
};

/** The lock's reason on a worktree made for the session `sessionId`. */
const lockReason = (sessionId: string): string => `agent-harness session ${sessionId}`;

/** Makes the worktree `request` asks for, for the session `sessionId`: see the module comment. */
export const makeWorktree = async (request: WorktreeRequest, sessionId: string, options: WorktreeMakerOptions): Promise<Resolution> => {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const git = (cwd: string, args: readonly string[], maxBytes = SMALL_BYTES, input?: Buffer): Promise<GitAnswer> =>
    runGit(cwd, args, { maxBytes, timeoutMs, ...(input !== undefined && { input }) });
  /** Runs git and answers what it printed, or throws the refusal of its failure. */
  const must = async (cwd: string, args: readonly string[]): Promise<string> => {
    const answer = await git(cwd, args);
    if (!answer.ok || answer.truncated) throw failure(answer, timeoutMs);
    return answer.stdout.toString("utf8");
  };
  /** Whether git answers exit 0 (yes) or 1 (no); anything else is its failure. */
  const asks = async (cwd: string, args: readonly string[]): Promise<boolean> => {
    const answer = await git(cwd, args);
    if (answer.code === 0 || answer.code === 1) return answer.code === 0;
    throw failure(answer, timeoutMs);
  };

  /** Where a worktree git lists lies as the environment records it, when inside its worktrees root; null for one of the user's. */
  const recordedAt = async (listed: string): Promise<string | null> => {
    for (const root of [options.root, await realpath(options.root).catch(() => options.root)]) {
      if (isInside(root, listed)) return join(options.root, relative(root, listed));
    }
    return null;
  };

  const checkedOut = async (repository: string, branch: string, listed: string): Promise<Refused> => {
    const recorded = await recordedAt(listed);
    const holder = recorded === null ? null : options.sessionAt(recorded);
    const worktree = recorded ?? listed;
    const whose = recorded === null ? "" : holder === null ? ", a worktree the harness made" : `, the workspace of the session ${holder}`;
    return refused("branch_checked_out", `The branch ${branch} is already checked out in ${worktree}${whose}; git checks a branch out in one worktree at a time.`, {
      repository,
      branch,
      worktree,
      ...(holder !== null && { sessionId: holder }),
    });
  };

  /** Copies in the untracked, ignored files the main checkout's `.worktreeinclude` names, the first 1,000 that are regular files. */
  const copyIncluded = async (checkout: string, worktree: string): Promise<void> => {
    const list = join(checkout, WORKTREE_INCLUDE);
    // A regular file, as the files it names are.
    if (!(await lstat(list).then((stats) => stats.isFile(), () => false))) return;
    // The untracked files its patterns match, then those of them git ignores.
    const named = await git(checkout, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${list}`], LISTING_BYTES);
    if (!named.ok) throw failure(named, timeoutMs);
    const candidates = named.truncated ? named.stdout.subarray(0, named.stdout.lastIndexOf(0) + 1) : named.stdout;
    if (candidates.length === 0) return;
    const ignored = await git(checkout, ["check-ignore", "-z", "--stdin"], LISTING_BYTES, candidates);
    // Exit 1 with nothing listed is check-ignore's "none of them is ignored".
    if (ignored.code === 1 && ignored.stdout.length === 0) return;
    if (!ignored.ok) throw failure(ignored, timeoutMs);
    const files = ignored.stdout.toString("utf8").split("\0");
    // The last is empty after the final NUL, or cut short at the cap.
    files.pop();
    let copied = 0;
    for (const file of files) {
      if (copied === MAX_INCLUDED_FILES) return;
      if (await copyInto(checkout, worktree, file)) copied += 1;
    }
  };

  const undos: (() => Promise<void>)[] = [];
  /** Removes what this create made, newest first, each step tried whatever the one before did; throws what was left behind. */
  const undo = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const step of [...undos].reverse()) await step().catch((error: unknown) => void failures.push(error));
    if (failures.length > 0) throw new AggregateError(failures, `Removing the worktree made for the session ${sessionId} left something behind.`);
  };
  /** Runs a removal's git call, throwing git's complaint when it fails. */
  const removal = async (cwd: string, args: readonly string[], what: string): Promise<void> => {
    const answer = await git(cwd, args);
    if (!answer.ok) throw new Error(`git could not remove ${what}: ${answer.timedOut ? "it did not finish in time" : gitComplaint(answer.stderr)}`);
  };

  try {
    const from = await startingDirectory(request.repository);
    if (from === null) throw refused("not_a_repository", `There is nothing at ${request.repository} on this environment.`, { path: request.repository });
    const listing = await git(from, ["worktree", "list", "--porcelain", "-z"], LISTING_BYTES);
    if (!listing.ok && !listing.missing && /not a git repository/i.test(listing.stderr)) {
      throw refused("not_a_repository", `${request.repository} is in no git repository.`, { path: request.repository });
    }
    if (!listing.ok || listing.truncated) throw failure(listing, timeoutMs);
    const [main, ...linked] = listedWorktrees(listing.stdout.toString("utf8"));
    if (main === undefined) throw gitFailed("git listed no worktrees.");
    const repository = main.path;

    const branch = request.branch ?? request.newBranch?.name ?? `agent-harness/${sessionId.slice(0, 8)}`;
    const exists = !notABranchName(branch) && (await asks(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]));
    if (request.branch !== undefined) {
      if (!exists) throw refused("branch_not_found", `The repository ${repository} has no local branch ${branch}.`, { repository, branch });
      const holder = [main, ...linked].find((worktree) => worktree.branch === `refs/heads/${branch}`);
      if (holder !== undefined) throw await checkedOut(repository, branch, holder.path);
    } else {
      if (exists) throw refused("branch_exists", `The repository ${repository} already has a branch ${branch}; ask for it as an existing branch, or name another.`, { repository, branch });
      if (request.newBranch?.base === undefined && !(await asks(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))) {
        throw refused("no_commits", `The repository ${repository} has no commit at its HEAD for a new branch to start from; make a first commit, or name a base.`, { repository });
      }
    }

    const path = await claimDirectory(options.root, repository, branch);
    undos.push(() => rm(path, { recursive: true, force: true }));
    if (request.branch === undefined) {
      const base = request.newBranch?.base;
      await must(repository, ["branch", "--", branch, ...(base === undefined ? [] : [base])]);
      const made = (await must(repository, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
      // The branch goes with the worktree only while it points where it was made: it holds no commits of anyone's.
      undos.push(async () => {
        const now = await git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (now.ok && now.stdout.toString("utf8").trim() === made) await removal(repository, ["branch", "-D", "--", branch], `the branch ${branch}`);
      });
    }
    await must(repository, ["worktree", "add", "--no-checkout", "--lock", "--reason", lockReason(sessionId), "--", path, branch]);
    // Forced twice: it is locked, and it is this create's own, which no run has used.
    undos.push(() => removal(repository, ["worktree", "remove", "--force", "--force", "--", path], `the worktree ${path}`));

    // Read as the new worktree sees the config, before anything is checked out that could run a filter.
    const configured = await repositoryFilters(path, timeoutMs);
    if ("failed" in configured) throw gitFailed(gitComplaint(configured.failed));
    if (configured.filters.length > 0) {
      throw refused(
        "git_filters_refused",
        `The repository ${repository} configures ${filtersNamed(configured.filters)}, which the environment will not run to check out a worktree: its own git runs outside any session's containment.`,
        { repository, filters: [...configured.filters] },
      );
    }
    await must(path, ["reset", "--hard", "--quiet", "--no-recurse-submodules"]);
    if (!main.bare) await copyIncluded(repository, path);

    const workspace: Workspace = { kind: "worktree", path, repository, branch };
    return { workspace, repositoryIdentity: await options.identityAt(path), undo };
  } catch (error) {
    await undo().catch((failed: unknown) => console.error("Removing what a refused worktree create made failed:", failed));
    if (error instanceof Refused) return { refused: error.refusal };
    throw error;
  }
};

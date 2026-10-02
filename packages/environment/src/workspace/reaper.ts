import { readdirSync, realpathSync, type Dirent } from "node:fs";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { WorkspaceKeptPayload, WorkspaceKeptReason } from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { PurgedSession } from "../sessions/deletion.js";
import { errorCode } from "./resolver.js";
import { GIT_TIMEOUT_MS, UNTRANSLATED, filtersNamed, gitComplaint, repositoryFilters, runGit, type GitAnswer } from "./git.js";
import { WORKSPACES_ACTOR } from "./identity-passes.js";
import { isInside } from "./paths.js";
import { removeTree } from "@agent-harness/filesystem";
import type { WorkspaceRoots } from "./roots.js";
import { WORKTREE_LIST, listedWorktrees } from "./worktree-listing.js";

/**
 * The reaper (workspace-picker spec, "The reaper"; #330): disk stays
 * bounded and no work is lost. A workspace inside a workspace root goes
 * once the last session naming it is purged, and what the roots hold that
 * no session names goes at startup.
 *
 * - **What a workspace is here**: the root decides, not the kind. The
 *   scratch root's entry holding the path (`<scratch>/<name>`), and the
 *   worktrees root's two levels down (`<worktrees>/<repository>/<branch>`,
 *   where the worktree maker puts one, `worktrees.ts`); so a completions
 *   session recorded as a `directory` in the scratch root goes as a scratch
 *   workspace does. A path anywhere else (outside the roots, the root
 *   itself, a repository's directory under the worktrees root, a root a
 *   later workstream declares) is never touched.
 * - **Named**: a session names a workspace when its recorded path lies
 *   inside it, or holds it inside the same root, compared as recorded, the
 *   root as the environment names it or as its links lead. Every session
 *   here counts, deleted ones in their grace period, settled and archived
 *   ones included, so a workspace shared by a `session` request or a fork
 *   stays until the last of them is purged.
 * - **Scratch** goes whatever it holds (a read-only directory made
 *   writable on the way), once its real path is inside the scratch root:
 *   one whose link leads out is left and logged.
 * - **Worktree**: unlocked, then removed with git's non-forcing
 *   `worktree remove` when it is clean, its ignored files with it; its
 *   branch is never deleted. Clean is Claude Code's check: `git status`
 *   lists no changed tracked file and no untracked file git does not
 *   ignore, a nested repository counting as one; a committed nested
 *   repository is read by its commit alone, since nothing runs inside it
 *   (#212), and git's own remove refuses one that is checked out. It stays,
 *   unlocked, when it is not clean (`uncommitted_changes`), when its
 *   repository's own config names a clean, smudge or process filter, which
 *   the check would run (`git_filters_refused`), or when git cannot check or
 *   remove it (`git_failed`). A directory a create claimed and was cut
 *   before git added the worktree into it is removed while empty.
 *
 * At a purge the reaper is told the session's workspace and title once the
 * purge commits (`sessions/deletion.ts`), and works off the log's path, one
 * workspace at a time, so two purges of one shared workspace never race. A
 * worktree it keeps is logged and noticed once, as `workspace.kept {path,
 * branch, title, reason}` on the environment stream. The startup sweep
 * reads what the roots hold that no session names at once, before anything
 * can make a workspace (a crash between a create's `prepare` and its commit
 * left it), then applies the same rules before the wire opens; a worktree
 * it keeps is logged, not noticed, and a repository's directory under the
 * worktrees root left empty goes. Every git call goes through the hardened
 * runner (`git.ts`).
 */

/** A workspace the reaper takes as one: an entry of the scratch root, or a worktree two levels under the worktrees root. */
export interface Stray {
  readonly root: "scratch" | "worktrees";
  /** As the environment names its root. */
  readonly path: string;
}

export interface ReaperOptions {
  /** The log: the sessions' recorded workspaces are read from it, and `workspace.kept` appended to it. */
  readonly log: Pick<EventLog, "read" | "append">;
  readonly roots: WorkspaceRoots;
  /** The environment's stream, where `workspace.kept` goes. */
  readonly stream: StreamRef;
  /** How long each git call gets; preset: the hardened runner's 15 seconds. */
  readonly gitTimeoutMs?: number;
}

export interface Reaper {
  /** A purge has committed: the session's workspace goes, off the log's path, when no other session names it. */
  purged(session: PurgedSession): void;
  /** What the roots hold that no session names, read at once: the startup sweep's work, read before anything can make a workspace. */
  strays(): readonly Stray[];
  /** The startup sweep: `strays` still named by no session, each by the reaper's rules, a kept worktree logged; settles once done. */
  sweep(strays: readonly Stray[]): Promise<void>;
  /** Settles once everything the reaper has taken up so far is done. */
  settled(): Promise<void>;
  /** Takes up nothing more, and settles once what is under way is done. */
  close(): Promise<void>;
}

/** The most of a worktree listing read. */
const LISTING_BYTES = 16 * 1024 * 1024;

/** The most of `git status` read: any of it is uncommitted work. */
const STATUS_BYTES = 4 * 1024;

/** A root as the environment names it and as its links lead. */
interface RootAt {
  readonly named: string;
  readonly real: string;
}

/** The segments of `path` below `root`, compared as the environment names the root and as its links lead; null when it is not below it. */
const below = (root: RootAt, path: string): readonly string[] | null => {
  for (const at of [root.named, root.real]) if (path !== at && isInside(at, path)) return relative(at, path).split(sep);
  return null;
};

/** The two roots the reaper takes workspaces from, each as named and as its links lead. */
type RootsAt = Readonly<Record<Stray["root"], RootAt>>;

/** Whether two places under one root overlap: one is the other, or holds it. */
const overlaps = (a: readonly string[], b: readonly string[]): boolean => a.every((segment, index) => index >= b.length || b[index] === segment);

/** Why a worktree stayed: the reason the notice gives, the branch checked out in it, and what the log says. */
interface Kept {
  readonly reason: WorkspaceKeptReason;
  readonly branch: string | null;
  readonly detail: string;
}

/** What became of a workspace: removed, found gone already, or kept. */
type Outcome = "removed" | "gone" | Kept;

/** A branch as the notice names it: without `refs/heads/`; null for a detached HEAD. */
const branchName = (ref: string | null): string | null => (ref?.startsWith("refs/heads/") === true ? ref.slice("refs/heads/".length) : null);

export const createReaper = (options: ReaperOptions): Reaper => {
  const { log, roots, stream } = options;
  const timeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const git = (cwd: string, args: readonly string[], maxBytes = 64 * 1024, env?: Readonly<Record<string, string>>): Promise<GitAnswer> =>
    runGit(cwd, args, { maxBytes, timeoutMs, ...(env !== undefined && { env }) });

  /** The line that says why a git call failed: no git, the timeout, or git's own. */
  const complaint = (answer: GitAnswer): string =>
    answer.missing ? "there is no git on this environment" : answer.timedOut ? `git did not finish in ${timeoutMs / 1000} s` : gitComplaint(answer.stderr);

  /** The two roots the reaper takes workspaces from, each as named and as its links lead now. */
  const rootsNow = async (): Promise<RootsAt> => {
    const at = async (named: string): Promise<RootAt> => ({ named, real: await realpath(named).catch(() => named) });
    return { scratch: await at(roots.scratch), worktrees: await at(roots.worktrees) };
  };

  /** The workspace holding `path` inside a root, as the reaper takes it; null outside the roots it reaps. */
  const strayAt = (path: string, at: RootsAt): Stray | null => {
    const scratch = below(at.scratch, path);
    if (scratch !== null) return { root: "scratch", path: join(roots.scratch, scratch[0] as string) };
    const worktree = below(at.worktrees, path);
    if (worktree !== null && worktree.length >= 2) return { root: "worktrees", path: join(roots.worktrees, worktree[0] as string, worktree[1] as string) };
    return null;
  };

  /** Every session's recorded workspace path, deleted sessions in their grace included. */
  const recordedPaths = (): string[] =>
    log.read<{ path: string }>("SELECT json_extract(workspace, '$.path') AS path FROM sessions").map(({ path }) => path);

  /** Whether one of the recorded `paths` names the workspace `stray`: lies inside it, or holds it inside the same root. */
  const named = (stray: Stray, at: RootsAt, paths: readonly string[]): boolean => {
    const root = at[stray.root];
    const place = below(root, stray.path) as readonly string[];
    return paths.some((path) => {
      const held = below(root, path);
      return held !== null && overlaps(held, place);
    });
  };

  /** Removes a scratch workspace whatever it holds, once its real path is inside the scratch root. */
  const reapScratch = async (stray: Stray, at: RootAt): Promise<void> => {
    const stats = await lstat(stray.path).catch(() => null);
    if (stats === null) return;
    const real = await realpath(stray.path).catch(() => null);
    if (real === null || real === at.real || !isInside(at.real, real)) {
      console.error(`The scratch workspace ${stray.path} leads outside the scratch root${real === null ? "" : `, to ${real}`}; it was left in place.`);
      return;
    }
    await removeTree(stray.path);
  };

  /** Removes a clean worktree, unlocked, with git's non-forcing remove; keeps one that is not, unlocked, saying why. */
  const reapWorktree = async (stray: Stray, recordedBranch: string | null): Promise<Outcome> => {
    const kept = (reason: WorkspaceKeptReason, branch: string | null, detail: string): Kept => ({ reason, branch, detail });
    const stats = await lstat(stray.path).catch(() => null);
    if (stats === null) return "gone";
    if (!stats.isDirectory()) return kept("git_failed", recordedBranch, "it is not a directory");
    const dotGit = await lstat(join(stray.path, ".git")).catch(() => null);
    if (dotGit === null) {
      // A directory a worktree create claimed, cut before git added the worktree into it: nothing of anyone's while empty.
      if ((await readdir(stray.path)).length > 0) return kept("git_failed", recordedBranch, "it holds no worktree git knows");
      await rmdir(stray.path);
      return "removed";
    }
    if (!dotGit.isFile()) return kept("git_failed", recordedBranch, "it is a repository of its own, not a worktree");

    const listing = await git(stray.path, WORKTREE_LIST, LISTING_BYTES, UNTRANSLATED);
    if (!listing.ok || listing.truncated) return kept("git_failed", recordedBranch, complaint(listing));
    const [main, ...linked] = listedWorktrees(listing.stdout.toString("utf8"));
    const real = await realpath(stray.path);
    const listed = linked.find((worktree) => worktree.path === real);
    if (main === undefined || listed === undefined) return kept("git_failed", recordedBranch, "git does not list it as a worktree of its repository");
    const branch = branchName(listed.branch);
    if (listed.locked) {
      const unlocked = await git(main.path, ["worktree", "unlock", "--", stray.path]);
      if (!unlocked.ok) return kept("git_failed", branch, complaint(unlocked));
    }

    // Read before anything compares contents, which would run a filter the repository's own config names (#212).
    const configured = await repositoryFilters(stray.path, timeoutMs);
    if ("failed" in configured) return kept("git_failed", branch, gitComplaint(configured.failed));
    if (configured.filters.length > 0) return kept("git_filters_refused", branch, `its repository configures ${filtersNamed(configured.filters)}`);
    const status = await git(stray.path, ["status", "--porcelain", "-z", "--untracked-files=normal", "--ignore-submodules=dirty"], STATUS_BYTES);
    if (status.stdout.length > 0) return kept("uncommitted_changes", branch, "it has uncommitted changes");
    if (!status.ok) return kept("git_failed", branch, complaint(status));
    const removed = await git(main.path, ["worktree", "remove", "--", stray.path]);
    if (!removed.ok) return kept("git_failed", branch, complaint(removed));
    return "removed";
  };

  const logKept = (path: string, { reason, detail }: Kept): void => console.error(`The worktree ${path} was left in place (${reason}): ${detail}.`);

  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  /** Runs `work` after everything taken up before it, a failure logged as `what`. */
  const takeUp = (what: string, work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch((error: unknown) => console.error(`${what} failed:`, error));
    return queue;
  };

  const reapPurged = async ({ workspace, title }: PurgedSession): Promise<void> => {
    const at = await rootsNow();
    const stray = strayAt(workspace.path, at);
    if (stray === null || named(stray, at, recordedPaths())) return;
    if (stray.root === "scratch") return reapScratch(stray, at.scratch);
    const outcome = await reapWorktree(stray, workspace.kind === "worktree" && workspace.path === stray.path ? workspace.branch : null);
    if (outcome === "removed" || outcome === "gone") return;
    logKept(stray.path, outcome);
    const payload: WorkspaceKeptPayload = { path: stray.path, branch: outcome.branch, title, reason: outcome.reason };
    log.append(stream, [{ type: "workspace.kept", payload }], { actor: WORKSPACES_ACTOR });
  };

  /** A root's entries that are directories; none when it is not there. */
  const directoriesIn = (path: string): string[] => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  };

  return {
    purged(session) {
      if (closed) return;
      void takeUp(`Removing the workspace ${session.workspace.path} of the purged session ${session.sessionId}`, () => reapPurged(session));
    },
    strays() {
      try {
        const rootAt = (named: string): RootAt => {
          try {
            return { named, real: realpathSync(named) };
          } catch {
            return { named, real: named };
          }
        };
        const at = { scratch: rootAt(roots.scratch), worktrees: rootAt(roots.worktrees) };
        const paths = recordedPaths();
        const found: Stray[] = [
          ...directoriesIn(roots.scratch).map((path): Stray => ({ root: "scratch", path })),
          ...directoriesIn(roots.worktrees).flatMap((repository) => directoriesIn(repository).map((path): Stray => ({ root: "worktrees", path }))),
        ];
        return found.filter((stray) => !named(stray, at, paths));
      } catch (error) {
        console.error("Reading what the workspace roots hold failed; the startup sweep passes over them:", error);
        return [];
      }
    },
    sweep(strays) {
      return takeUp("The startup sweep of the workspace roots", async () => {
        const at = await rootsNow();
        const paths = recordedPaths();
        for (const stray of strays.filter((each) => !named(each, at, paths))) {
          try {
            if (stray.root === "scratch") await reapScratch(stray, at.scratch);
            else {
              const outcome = await reapWorktree(stray, null);
              if (outcome !== "removed" && outcome !== "gone") logKept(stray.path, outcome);
            }
          } catch (error) {
            console.error(`The startup sweep could not remove ${stray.path}; the next start tries again:`, error);
          }
        }
        // A repository's directory the sweep left empty goes; one holding anything stays.
        for (const repository of new Set(strays.filter((stray) => stray.root === "worktrees").map((stray) => dirname(stray.path)))) {
          await rmdir(repository).catch(() => undefined);
        }
      });
    },
    settled: () => queue,
    close() {
      closed = true;
      return queue;
    },
  };
};

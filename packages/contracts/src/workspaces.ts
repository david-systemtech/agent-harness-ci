import { z } from "zod";
import { Timestamp } from "./primitives.js";
import { AbsolutePath, SessionId, WorkspaceProblem } from "./sessions.js";
import { GitCommit } from "./skills.js";

/**
 * Browsing and inspecting an environment's directories (workspace-picker
 * spec, "Browsing an environment's directories"; #331): a client's own file
 * dialog cannot see another machine, so the picker asks the environment what
 * a directory holds and whether a session could work there, and, in a
 * repository, what the worktree step needs.
 */

/** The most subdirectories `workspaces.browse` answers. */
export const WORKSPACES_BROWSE_CAP = 1_000;

/** The most local branches `workspaces.inspect` answers. */
export const WORKSPACES_INSPECT_BRANCH_CAP = 200;

/** One subdirectory `workspaces.browse` lists. */
export const BrowsedDirectory = z
  .object({
    name: z.string().min(1).meta({ description: "The subdirectory's name in the directory browsed." }),
    repository: z.boolean().meta({
      description: "True when it is the root of a git repository: a checkout (it holds .git) or a bare repository.",
    }),
  })
  .meta({ description: "A subdirectory of the directory browsed, marked when it is a repository's root." });
export type BrowsedDirectory = z.infer<typeof BrowsedDirectory>;

/** A commit as the picker shows one: its object name and when it was committed. */
export const InspectedCommit = z
  .object({
    commit: GitCommit,
    committedAt: Timestamp.meta({ description: "The commit's committer date." }),
  })
  .meta({ description: "A commit and its committer date." });
export type InspectedCommit = z.infer<typeof InspectedCommit>;

/** One local branch `workspaces.inspect` lists, with the worktree that holds it. */
export const InspectedBranch = z
  .object({
    name: z.string().min(1).meta({ description: "The branch's name, without refs/heads/." }),
    ...InspectedCommit.shape,
    worktree: AbsolutePath.nullable().meta({
      description:
        "The worktree the branch is checked out in (the main checkout among them), where a worktree on it cannot be made; null when none holds it.",
    }),
    sessionId: SessionId.nullable().meta({
      description: "When the harness made that worktree for a session on this environment: the session whose workspace it is; else null.",
    }),
  })
  .meta({ description: "A local branch at its latest commit, with the worktree holding it." });
export type InspectedBranch = z.infer<typeof InspectedBranch>;

/** What `workspaces.inspect` tells of the repository holding a path: what the worktree step needs. */
export const InspectedRepository = z
  .object({
    root: AbsolutePath.meta({
      description: "The top of the worktree holding the path; for a path in no worktree (a bare repository), the repository's own directory.",
    }),
    mainCheckout: AbsolutePath.meta({ description: "The main checkout, or the bare repository: what a worktree is made from." }),
    bare: z.boolean().meta({ description: "True for a bare repository, which has no checkout of its own." }),
    repositoryIdentity: z.string().nullable().meta({
      description: "The repository identity a session working at the path would get, by the rule sessions.create applies; null when its remote gives none.",
    }),
    branch: z.string().min(1).nullable().meta({ description: "The branch checked out at the path, without refs/heads/; null when HEAD is detached." }),
    head: InspectedCommit.nullable().meta({ description: "The commit HEAD is at, and its date; null before the first commit." }),
    originHead: z.string().min(1).nullable().meta({
      description: "The branch origin/HEAD points at, as git last cached it (origin/main); null when none is cached. Nothing is fetched.",
    }),
    branches: z.array(InspectedBranch).meta({
      description: "The local branches, the most recently committed first (by name among equals), at most 200.",
    }),
    branchesTruncated: z.boolean().meta({ description: "True when the repository has more than the 200 branches listed." }),
  })
  .meta({ description: "The repository holding an inspected path, as the worktree step reads it." });
export type InspectedRepository = z.infer<typeof InspectedRepository>;

/** What `workspaces.inspect` answers: the path as a directory request would record it, whether a session could work there, and its repository. */
export const WorkspaceInspection = z
  .object({
    path: AbsolutePath.meta({ description: "The path as a directory request records it: ~ expanded, . and .. resolved, symlinks kept." }),
    problem: WorkspaceProblem.nullable().meta({
      description: "Why a directory request for the path would be refused workspace_unusable; null when a session could work there.",
    }),
    repository: InspectedRepository.nullable().meta({
      description: "The git repository holding the path, when a session could work there; null outside any repository, or where the environment has no git.",
    }),
  })
  .meta({ description: "Whether a path would be a usable directory workspace, and the repository holding it." });
export type WorkspaceInspection = z.infer<typeof WorkspaceInspection>;

/**
 * Why the reaper kept a worktree at its last session's purge
 * (workspace-picker spec, "The reaper"; #330): it has uncommitted work (a
 * tracked file changed, or an untracked file git does not ignore, a nested
 * repository included); its repository's own config names a clean, smudge
 * or process filter, which checking it would run (#212); or git could not
 * say, or could not remove it.
 */
export const WORKSPACE_KEPT_REASONS = ["uncommitted_changes", "git_filters_refused", "git_failed"] as const;
export const WorkspaceKeptReason = z.enum(WORKSPACE_KEPT_REASONS).meta({
  description:
    "Why a worktree stayed at its last session's purge: uncommitted_changes (a tracked file changed, or an untracked file git does not ignore, a nested repository included), git_filters_refused (its repository's own config names a clean, smudge or process filter, which checking it would run) or git_failed (git could not check or remove it).",
});
export type WorkspaceKeptReason = z.infer<typeof WorkspaceKeptReason>;

/** What `workspace.kept` records: the worktree the reaper left in place, unlocked, and why (#330). */
export const WorkspaceKeptPayload = z
  .object({
    path: AbsolutePath.meta({ description: "The worktree, under the environment's worktrees root, as the environment records it." }),
    branch: z.string().min(1).nullable().meta({ description: "The branch checked out in it as git lists it, without refs/heads/; when git cannot list it, the branch the purged session recorded it was made on. Null when its HEAD is detached, or when git cannot list it and the session recorded no branch for it." }),
    title: z.string().min(1).meta({ description: "The title of the purged session whose worktree it was, as the list showed it." }),
    reason: WorkspaceKeptReason,
  })
  .meta({
    description:
      "A worktree the environment made stayed when the last session naming it was purged, unlocked, so no work is lost: where it is, its branch, whose it was and why.",
  });
export type WorkspaceKeptPayload = z.infer<typeof WorkspaceKeptPayload>;

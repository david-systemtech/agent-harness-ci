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

import { z } from "zod";
import { defineMethod } from "../method.js";
import { AbsolutePath, RequestedDirectory } from "../sessions.js";
import { BrowsedDirectory, WorkspaceInspection } from "../workspaces.js";

/**
 * Browsing and inspecting the environment's directories (workspace-picker
 * spec, "Browsing an environment's directories"; #331): queries at scope
 * `terminal`, the scope of `files.*`, since a client with a terminal can
 * list any directory anyway. A path is absolute, or starts `~` for the
 * environment's home, and is read as a directory request's is (`.` and `..`
 * resolved as written, symlinks kept); a relative one is `invalid_params`.
 * Every git call runs through the environment's hardened git and checks
 * nothing out, so no hook, fsmonitor or filter of the repository's runs.
 */

/**
 * The subdirectories of `path` (preset: the environment's home), by name in
 * code-unit order, each marked when it is a repository's root, with a
 * symlink to a directory among them; dot-directories only with `hidden`. At
 * most 1,000, with `truncated` past that. A path with no directory is
 * `not_found`, data `kind: directory`; one the environment cannot list is
 * `conflict`, reason `not_readable`.
 */
export const workspacesBrowse = defineMethod({
  name: "workspaces.browse",
  scope: "terminal",
  kind: "query",
  params: z.object({
    path: RequestedDirectory.optional().meta({ description: "The directory to list; the environment's home when absent." }),
    hidden: z.boolean().optional().meta({ description: "True to list dot-directories too; they are left out otherwise." }),
  }),
  result: z.object({
    path: AbsolutePath.meta({ description: "The directory listed, as a directory request records it: ~ expanded, . and .. resolved, symlinks kept." }),
    parent: AbsolutePath.nullable().meta({ description: "The directory enclosing it; null at a root." }),
    directories: z.array(BrowsedDirectory),
    truncated: z.boolean().meta({ description: "True when the directory holds more than the 1,000 subdirectories listed." }),
  }),
  errors: [],
});

/**
 * Whether `path` would be a usable directory workspace, with the resolver's
 * `problem` when it would not; and, for a usable one inside a git
 * repository, what the worktree step needs: the repository's root, main
 * checkout and whether it is bare, the identity a session there would get,
 * the branch and `HEAD` with its date, the cached `origin/HEAD`, and up to
 * 200 local branches by latest commit, each with the worktree holding it
 * and, when the harness made that worktree, its session. Nothing is
 * fetched. Where the environment has no git there is no repository, as a
 * session there gets no identity; where git runs and fails inside one it is
 * `conflict`, reason `git_failed`, with git's own complaint.
 */
export const workspacesInspect = defineMethod({
  name: "workspaces.inspect",
  scope: "terminal",
  kind: "query",
  params: z.object({ path: RequestedDirectory.meta({ description: "The path to inspect." }) }),
  result: WorkspaceInspection,
  errors: [],
});

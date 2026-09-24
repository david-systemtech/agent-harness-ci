import { z } from "zod";
import { defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { SessionDiffFile } from "../terminals.js";

/**
 * The diff methods (tui spec, "Terminals, files and diffs"; #124), read-only,
 * at scope `terminal`. Each answers at most 8 MiB of diff text, cut at a line
 * boundary, with `truncated` when there was more. A session that is not on
 * this environment, or is deleted, is `not_found` with data `kind: session`.
 */

/**
 * The unified diff of the workspace against its repository's HEAD (against
 * the empty tree before the first commit), staged and unstaged changes
 * together, untracked files that are not ignored shown as new files, paths
 * relative to the workspace; `repository` false, and no diff, when the
 * workspace is in no git repository; `conflict`, reason `git_unavailable`,
 * when the environment has no git, and reason `git_failed`, with git's own
 * complaint (its `fatal:` line), when git runs and fails.
 */
export const diffsWorkingTree = defineMethod({
  name: "diffs.workingTree",
  scope: "terminal",
  kind: "query",
  params: z.object({ sessionId: SessionId }),
  result: z.object({
    diff: z.string(),
    truncated: z.boolean(),
    repository: z.boolean().meta({ description: "False when the workspace is in no git repository, so there is nothing to diff." }),
  }),
  errors: [],
});

/**
 * What the session's runs changed, per file, folded from the file-editing
 * tool calls on its transcript that ended `ok` (Claude's Edit, MultiEdit,
 * Write and NotebookEdit), in the order the files were first changed.
 */
export const diffsSession = defineMethod({
  name: "diffs.session",
  scope: "terminal",
  kind: "query",
  params: z.object({ sessionId: SessionId }),
  result: z.object({ files: z.array(SessionDiffFile), truncated: z.boolean() }),
  errors: [],
});

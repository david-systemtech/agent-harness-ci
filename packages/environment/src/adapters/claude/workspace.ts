import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The checkout a worktree belongs to (claude-adapter spec, options per run:
 * `projectConfigRoot` for a worktree's checkout). A git worktree's `.git` is
 * a file naming its own git directory under the main checkout's
 * `.git/worktrees/`, whose `commondir` names the shared `.git`; the main
 * checkout is the directory holding that. Its project settings, `.mcp.json`
 * and `.claude` trees are what a trusted run of any of its worktrees loads,
 * so whatever the branch checked out carries is not what the session runs.
 * Null for a plain checkout, a directory that is not one, or anything unreadable.
 */
export const worktreeCheckout = (workspace: string): string | null => {
  try {
    const dotGit = join(workspace, ".git");
    if (!statSync(dotGit).isFile()) return null;
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (match?.[1] === undefined) return null;
    const gitDir = isAbsolute(match[1]) ? match[1] : resolve(workspace, match[1]);
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    const commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
    const checkout = dirname(commonDir);
    return checkout === workspace ? null : checkout;
  } catch {
    return null;
  }
};

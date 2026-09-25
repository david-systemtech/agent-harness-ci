import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunContainment, ToolAccess } from "../adapter/contract.js";

/**
 * The tool gate's containment rule (permissions spec, "Containment" and
 * "Modules": the tool gate): what a run's containment denies of a tool call
 * that does not pass through the provider's sandbox. At `workspace` a write
 * outside the workspace, the session's scratch directory and the run's
 * temporary directory; at `workspace-no-network` that, and every fetch and
 * search. Shell commands are the sandbox's (Claude's `sandbox` option,
 * #140), reads are free at every level (the denylist's paths are #132's),
 * and `off` denies nothing. A denial is final: the model is told why, and
 * that asking again will not widen it.
 *
 * A path is read as the file system will: relative to the workspace, `~` as
 * the home directory, and through every symbolic link on the way, so a link
 * inside the workspace that points out of it leads out of it. A path that
 * does not exist yet is resolved through its deepest ancestor that does.
 */

/** `path` as the file system resolves it: absolute, `~` expanded, symbolic links followed as far as the path exists. */
export const resolvePath = (path: string, base: string): string => {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const absolute = resolve(base, expanded);
  const rest: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch {
      const parent = dirname(head);
      // The root itself cannot be resolved: the path as it was written, made absolute.
      if (parent === head) return absolute;
      rest.unshift(basename(head));
      head = parent;
    }
  }
};

/** Whether `path` is `root` or lies under it. */
const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

const NOT_WIDENED = "Containment is a setting the user changes; asking again will not widen it. Continue without it and say what you could not do.";

/**
 * Why `access` is denied under `containment`, as the model is told it; null
 * when containment lets it through to the provider's own evaluation.
 * `workspace` is the directory relative paths are read against.
 */
export const containmentDenial = (containment: RunContainment, workspace: string, access: ToolAccess): string | null => {
  if (containment.level === "off") return null;
  if (access.kind === "write") {
    const roots = containment.writable.map((root) => resolvePath(root, workspace));
    const outside = access.paths.find((path) => !roots.some((root) => within(root, resolvePath(path, workspace))));
    if (outside === undefined) return null;
    const [workspaceRoot = workspace] = containment.writable;
    return (
      `Denied by containment (${containment.level}): this run may write only inside its workspace (${workspaceRoot}), ` +
      `the session's scratch directory (${containment.scratchDirectory}) and its own temporary directory (${containment.temporaryDirectory}), ` +
      `and ${outside} is outside them. ${NOT_WIDENED}`
    );
  }
  if ((access.kind === "fetch" || access.kind === "search") && !containment.network) {
    const what = access.kind === "fetch" ? `fetching ${access.urls.join(", ")}` : "a web search";
    return `Denied by containment (${containment.level}): this run has no network, so ${what} cannot reach any host. ${NOT_WIDENED}`;
  }
  return null;
};

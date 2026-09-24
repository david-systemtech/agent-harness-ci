import { realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { ContractError, invalidParams } from "@agent-harness/contracts";

/**
 * The one guard every file method passes a path through (tui spec: "Paths
 * never escape the workspace"). A path is relative to the session's
 * workspace, with either slash; it is refused `invalid_params`, reason
 * `escapes_workspace`, when it is absolute (a POSIX root, a drive letter or a
 * UNC share, on every platform, so the vocabulary does not change with the
 * environment's), holds a `..` segment or a NUL, or resolves, symlinks
 * followed, to somewhere outside the workspace's own real path. A path with
 * nothing there is `not_found`, kind `file`: a dangling link included, so
 * the answer says nothing about what lies outside.
 */

/** A path the guard let through: where it is on disk, and as the workspace names it. */
export interface WorkspaceFile {
  /** The real path, symlinks resolved, inside the workspace's real path. */
  readonly absolute: string;
  /** Relative to the workspace, with forward slashes; empty for the workspace itself. */
  readonly relative: string;
}

/** The refusal of a path that would leave the workspace. */
export const escapesWorkspace = (message: string): ContractError => {
  const error = invalidParams([{ code: "custom", path: ["path"], message }], message);
  return new ContractError({ ...error, data: { ...error.data, reason: "escapes_workspace" } });
};

const notFound = (path: string): ContractError =>
  new ContractError({ code: "not_found", message: `There is no file at ${path} in the workspace.`, data: { kind: "file", path } });

/** The workspace's own real path; a workspace directory that is gone is a `conflict`, reason `workspace_missing`. */
export const workspaceRoot = async (root: string): Promise<string> => {
  try {
    return await realpath(root);
  } catch {
    throw new ContractError({
      code: "conflict",
      message: `The session's workspace ${root} is not there.`,
      data: { reason: "workspace_missing", path: root },
    });
  }
};

/** Whether `path` is inside (or is) `root`, both real paths. */
export const isInside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Resolves `requested` inside the workspace at `root`, or throws the refusal the module's comment names. */
export const resolveInWorkspace = async (root: string, requested: string): Promise<WorkspaceFile> => {
  if (requested.includes("\0")) throw escapesWorkspace("A path cannot hold a NUL byte.");
  if (isAbsolute(requested) || /^[\\/]/.test(requested) || /^[A-Za-z]:/.test(requested)) {
    throw escapesWorkspace("A path is relative to the workspace; an absolute one is refused.");
  }
  const segments = requested.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw escapesWorkspace("A path cannot leave the workspace through a .. segment.");
  const relative = segments.join("/");

  const realRoot = await workspaceRoot(root);
  let real: string;
  try {
    real = await realpath(join(realRoot, ...segments));
  } catch {
    throw notFound(relative);
  }
  if (!isInside(realRoot, real)) throw escapesWorkspace("The path leads outside the workspace through a symlink.");
  return { absolute: real, relative };
};

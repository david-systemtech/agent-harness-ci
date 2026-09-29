/**
 * Paths in a session's workspace, as both renderers read them (docs/specs/tui.md,
 * "The transcript" and "The composer"; docs/specs/gui.md, "The seven panes and
 * the grid"): the environment names files relative to the workspace with
 * forward slashes, and a path a tool call or a person gave is placed under it
 * or refused as outside it. Pure.
 */

/** A Windows path: a drive's (`C:\`, `C:/`) or a share's (`\\server\share`). */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * `path` and `root` with forward slashes when either is a Windows path, as a
 * Windows environment's workspace and its tools' paths are (backslashes, a
 * drive); `windows` then, whose names ignore case. A POSIX name may hold a
 * backslash, so a POSIX pair is left as it is.
 */
export const slashed = (path: string, root: string): { readonly path: string; readonly root: string; readonly windows: boolean } =>
  WINDOWS_PATH.test(path) || WINDOWS_PATH.test(root)
    ? { path: path.replace(/\\/g, "/"), root: root.replace(/\\/g, "/"), windows: true }
    : { path, root, windows: false };

/** Whether a path with forward slashes is absolute: from `/` (a share's `//` too), or from a drive's `C:/`. */
export const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:\//.test(path);

/**
 * `given` relative to the workspace at `workspace`, with forward slashes; null when it is outside it, or absolute with no
 * workspace known yet. A Windows environment's paths are read with forward slashes and its names ignoring case (`slashed`).
 */
export const inWorkspace = (given: string, workspace: string): string | null => {
  const { path, root, windows } = slashed(given, workspace);
  const base = root.replace(/\/+$/, "");
  const absolute = isAbsolutePath(path);
  if (absolute && base === "" && root !== "/") return null;
  const under = `${base}/`;
  const inside = windows ? path.slice(0, under.length).toLowerCase() === under.toLowerCase() : path.startsWith(under);
  const relative = absolute ? (inside ? path.slice(under.length) : null) : path.replace(/^(\.\/)+/, "");
  if (relative === null || relative.length === 0) return null;
  return relative.split("/").includes("..") ? null : relative;
};

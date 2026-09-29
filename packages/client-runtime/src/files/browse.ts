import { inWorkspace, isAbsolutePath, slashed } from "./paths.js";

/**
 * Browsing `files.list` one directory at a time, as the terminal UI's
 * `/files` picker (docs/specs/tui.md, "The composer") and the window's Files
 * pane (docs/specs/gui.md, "The seven panes and the grid") both do. The
 * environment lists the workspace flat, as paths relative to it with forward
 * slashes, so a directory here is every path under it. Without a filter one
 * directory is shown: the way up (below the root), its directories with how
 * many files each holds, then its files, each by name. A filter typed at it
 * finds files anywhere under the directory whose path holds it, ignoring
 * case. Pure.
 */

export type BrowseRow =
  | { readonly kind: "up"; readonly path: string; readonly name: string }
  | { readonly kind: "dir"; readonly path: string; readonly name: string; readonly files: number }
  | { readonly kind: "file"; readonly path: string; readonly name: string };

/** A path as the listing writes one: no leading `./` or `/`, no trailing `/`, `.` the root (""). */
const normalized = (path: string): string =>
  path
    .trim()
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "");

/** The directory a path is in; the root is "". */
export const directoryOf = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
};

const byName = (a: { readonly name: string }, b: { readonly name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The rows of `dir` (the root is ""), or of what `filter` finds under it. */
export const browse = (files: readonly string[], dir: string, filter: string): readonly BrowseRow[] => {
  const prefix = dir === "" ? "" : `${dir}/`;
  const under = files.filter((path) => path.startsWith(prefix));
  const needle = filter.trim().toLowerCase();
  if (needle.length > 0) {
    return under
      .filter((path) => path.slice(prefix.length).toLowerCase().includes(needle))
      .map((path): BrowseRow => ({ kind: "file", path, name: path.slice(prefix.length) }));
  }
  const dirs = new Map<string, number>();
  const own: BrowseRow[] = [];
  for (const path of under) {
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) own.push({ kind: "file", path, name: rest });
    else {
      const name = rest.slice(0, slash);
      dirs.set(name, (dirs.get(name) ?? 0) + 1);
    }
  }
  const up: BrowseRow[] = dir === "" ? [] : [{ kind: "up", path: directoryOf(dir), name: "../" }];
  const folders = [...dirs].map(([name, count]): BrowseRow => ({ kind: "dir", path: `${prefix}${name}`, name: `${name}/`, files: count })).sort(byName);
  return [...up, ...folders, ...own.sort(byName)];
};

/** `path` with its `.` and `..` segments resolved; null when a `..` climbs above the start, which is out of the workspace. */
const settled = (path: string): string | null => {
  const kept: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") kept.push(segment);
    else if (kept.pop() === undefined) return null;
  }
  return kept.join("/");
};

/**
 * What a path typed after `/files` names in the workspace at `workspace`, as the
 * listing writes paths; an absolute one inside the workspace is the path
 * under it. Its `.` and `..` segments are resolved first. Null for a path
 * outside it. A Windows environment's paths are read with forward slashes
 * (`slashed`).
 */
export const typedPath = (typed: string, workspace: string): string | null => {
  const { path, root, windows } = slashed(typed.trim(), workspace);
  // A relative path is refused here when it climbs out, as an absolute one outside the workspace is below: the
  // environment would refuse it too, but with its own line, after a round trip.
  if (!isAbsolutePath(path)) return settled(normalized(path));
  // Its root (`/`, a share's `//`, a drive's `C:/`) kept, the rest settled: a `..` above the root is nowhere.
  const lead = /^([A-Za-z]:)?\/+/.exec(path)?.[0] ?? "";
  const rest = settled(path.slice(lead.length));
  if (rest === null) return null;
  const bare = `${lead}${rest}`.replace(/\/+$/, "");
  const top = root.replace(/\/+$/, "");
  if (bare !== "" && (windows ? bare.toLowerCase() === top.toLowerCase() : bare === top)) return "";
  const inside = inWorkspace(bare, root);
  return inside === null ? null : normalized(inside);
};

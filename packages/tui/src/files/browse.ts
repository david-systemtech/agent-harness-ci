/**
 * `/files`' picker (docs/specs/tui.md, "The composer": `/files [path]` opens
 * `files.list` as a browsable picker). The environment lists the workspace
 * flat, as paths relative to it with forward slashes, so a directory here is
 * every path under it. Without a filter the picker shows one directory: the
 * way up (below the root), its directories with how many files each holds,
 * then its files, each by name. A filter typed at it finds files anywhere
 * under the directory whose path holds it, ignoring case. Pure.
 */

export type BrowseRow =
  | { readonly kind: "up"; readonly path: string; readonly name: string }
  | { readonly kind: "dir"; readonly path: string; readonly name: string; readonly files: number }
  | { readonly kind: "file"; readonly path: string; readonly name: string };

/** A path as the listing writes one: no leading `./` or `/`, no trailing `/`. */
export const normalized = (path: string): string =>
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

/** What a path typed after `/files` names in the listing. */
export const locate = (files: readonly string[], typed: string): { readonly kind: "file" | "dir" | "none"; readonly path: string } => {
  const path = normalized(typed);
  if (path === "") return { kind: "dir", path };
  if (files.includes(path)) return { kind: "file", path };
  if (files.some((file) => file.startsWith(`${path}/`))) return { kind: "dir", path };
  return { kind: "none", path };
};

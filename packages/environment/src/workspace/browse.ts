import { opendir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ContractError, WORKSPACES_BROWSE_CAP, type BrowsedDirectory, type ResultOf } from "@agent-harness/contracts";
import { NOT_THERE, errorCode, type DirectoryRules } from "./resolver.js";

/**
 * `workspaces.browse` (workspace-picker spec, "Browsing an environment's
 * directories"; #331): the subdirectories of a directory the environment
 * has, for a picker whose own file dialog cannot see this machine.
 *
 * Its subdirectories are listed by name in code-unit order, a symlink that
 * leads to a directory among them (it is entered as one); files and
 * anything else are left out, and dot-directories are too unless `hidden`
 * asks for them. The first 1,000 are answered, with `truncated` past that.
 * Each is marked when it is a repository's root, read from the file system
 * alone, since a git process per entry would be a thousand: a checkout
 * holds `.git` (a directory, or the file a linked worktree or a submodule
 * has), and a bare repository has its own `HEAD` file and `objects` and
 * `refs` directories, as git tells a git directory. No git runs.
 *
 * The directory is judged by the resolver's rule first, so the picker
 * offers what a directory request would take: a path with no directory
 * there is `not_found`, kind `directory`, and one the environment's user
 * cannot list and enter is `conflict`, reason `not_readable`. A directory
 * reserved as a workspace (the data directory's own) is listed all the same.
 */

/** A name the directory holds that may be a subdirectory: a directory, or an entry only a `stat` can tell (a symlink, a type the file system does not give). */
interface Candidate {
  readonly name: string;
  /** Whether it is known to be a directory; otherwise a `stat` decides, once it is among those answered. */
  readonly directory: boolean;
}

/** Code-unit order, so a listing does not depend on anybody's locale. */
const byName = (a: Candidate, b: Candidate): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Whether `path` leads to a directory, links followed; nothing there is none. */
const leadsToDirectory = (path: string): Promise<boolean> => stat(path).then((info) => info.isDirectory(), () => false);

/** Whether the directory at `path` is a repository's root: see the module comment. */
const isRepositoryRoot = async (path: string): Promise<boolean> => {
  const statOf = (name: string) => stat(join(path, name)).catch(() => null);
  const dotGit = await statOf(".git");
  if (dotGit !== null) return dotGit.isDirectory() || dotGit.isFile();
  const [head, objects, refs] = await Promise.all([statOf("HEAD"), statOf("objects"), statOf("refs")]);
  return head?.isFile() === true && objects?.isDirectory() === true && refs?.isDirectory() === true;
};

/** A path with no directory there: `not_found`, kind `directory`. */
const noDirectory = (path: string): ContractError =>
  new ContractError({ code: "not_found", message: `There is no directory ${path} on this environment.`, data: { kind: "directory", path } });

/** A directory the environment's user cannot list and enter: `conflict`, reason `not_readable`. */
const notReadable = (path: string): ContractError =>
  new ContractError({ code: "conflict", message: `The environment cannot list or enter ${path}.`, data: { reason: "not_readable", path } });

/** The refusal of a directory the listing found gone or closed after the rule passed it; undefined for any other failure. */
const unlistable = (path: string, error: unknown): ContractError | undefined => {
  const code = errorCode(error) ?? "";
  if (NOT_THERE.has(code)) return noDirectory(path);
  return code === "EACCES" || code === "EPERM" ? notReadable(path) : undefined;
};

/** The subdirectories of the directory at `path` (absolute, as recorded), judged by `rules`: see the module comment. */
export const browseDirectory = async (path: string, hidden: boolean, rules: Pick<DirectoryRules, "problemWith">): Promise<ResultOf<"workspaces.browse">> => {
  const problem = await rules.problemWith(path);
  if (problem === "does_not_exist" || problem === "not_a_directory") throw noDirectory(path);
  if (problem === "not_readable") throw notReadable(path);
  const candidates: Candidate[] = [];
  try {
    for await (const entry of await opendir(path)) {
      if (!hidden && entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) candidates.push({ name: entry.name, directory: true });
      else if (!entry.isFile()) candidates.push({ name: entry.name, directory: false });
    }
  } catch (error) {
    throw unlistable(path, error) ?? error;
  }
  candidates.sort(byName);

  const names: string[] = [];
  let truncated = false;
  for (const candidate of candidates) {
    if (!candidate.directory && !(await leadsToDirectory(join(path, candidate.name)))) continue;
    if (names.length === WORKSPACES_BROWSE_CAP) {
      truncated = true;
      break;
    }
    names.push(candidate.name);
  }
  // A checkout's own `.git`, listed with `hidden`, is its git directory, not a repository to work in.
  const directories = await Promise.all(
    names.map(async (name): Promise<BrowsedDirectory> => ({ name, repository: name !== ".git" && (await isRepositoryRoot(join(path, name))) })),
  );
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, directories, truncated };
};

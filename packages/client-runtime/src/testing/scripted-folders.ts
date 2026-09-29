import type { InspectedBranch, JsonObject, ResultOf, Workspace, WorkspaceRequest } from "@agent-harness/contracts";
import type { FakeAnswer } from "./fake-wire.js";

/**
 * The scripted environment's directories (`scripted-environment.ts`), as the
 * picker reads them (workspace-picker spec, "Browsing an environment's
 * directories"; #331) and a `worktree` request makes from them (#330):
 * `workspaces.browse` lists a directory's subdirectories, `workspaces.inspect`
 * tells whether a path is usable and what repository holds it, and a
 * `worktree` request is resolved as the environment's worktree maker
 * resolves one, with its refusals, the branch it made then held by the new
 * worktree and its session. No file system is touched: the script names its
 * directories, each one's parents being directories too, and the home.
 */

/** A directory the scripted environment has. */
export interface ScriptedFolder {
  /** The root of a checkout there: what `workspaces.inspect` tells of it, and what a `worktree` request is made from. */
  readonly repository?: ScriptedRepository;
  /** The environment's user cannot list it: `workspaces.browse` refuses it `not_readable`. */
  readonly unreadable?: boolean;
  /** `workspaces.browse` says it holds more subdirectories than it listed. */
  readonly truncated?: boolean;
}

/** A checkout, as `workspaces.inspect` reads it. */
export interface ScriptedRepository {
  /** The identity a session there gets: preset none. */
  readonly identity?: string | null;
  /** The branch the checkout has out: preset `main`. */
  readonly branch?: string;
  /** The branch `origin/HEAD` points at, without `origin/`: preset none cached. */
  readonly originHead?: string | null;
  /** Its other local branches, the most recently committed first: preset none. */
  readonly branches?: readonly ScriptedBranch[];
  /** Whether it has more branches than inspect lists. */
  readonly branchesTruncated?: boolean;
}

/** A local branch, and the worktree holding it (with that worktree's session when the harness made it). */
export interface ScriptedBranch {
  readonly name: string;
  readonly worktree?: string;
  readonly sessionId?: string;
  /** Preset: the scripted clock's now when the script is read. */
  readonly committedAt?: string;
}

/** Where a `worktree` request's refusal comes from: the reason with its data, and the environment's line. */
export interface ScriptedRefusal {
  readonly code: string;
  readonly message: string;
  readonly data: JsonObject;
}

export interface ScriptedFolders {
  browse(params: Record<string, unknown>): FakeAnswer;
  inspect(params: Record<string, unknown>): FakeAnswer;
  /** The workspace a `worktree` request makes for the session `id`, or its refusal. */
  worktree(request: Extract<WorkspaceRequest, { readonly kind: "worktree" }>, id: string): { readonly workspace: Workspace; readonly repositoryIdentity: string | null } | { readonly refused: ScriptedRefusal };
}

/** The commit every scripted branch is at: one object name, written out at run time. */
const COMMIT = "c".repeat(40);

/** A path's parent: null at the root. */
const parentOf = (path: string): string | null => (path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/");
const childOf = (path: string, name: string): string => (path === "/" ? `/${name}` : `${path}/${name}`);
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export const scriptedFolders = (options: { readonly home: string; readonly now: () => string; readonly folders?: Readonly<Record<string, ScriptedFolder>> }): ScriptedFolders => {
  const folders = new Map(Object.entries(options.folders ?? {}));
  const at = options.now();
  /** Every directory there is: the script's, their parents, the home and its. */
  const directories = new Set<string>();
  for (const path of [...folders.keys(), options.home]) for (let p: string | null = path; p !== null; p = parentOf(p)) directories.add(p);
  /** The branches each checkout has, by its root, as creates change them. */
  const branches = new Map<string, InspectedBranch[]>(
    [...folders].flatMap(([root, folder]) => {
      const repository = folder.repository;
      if (repository === undefined) return [];
      const own = { name: repository.branch ?? "main", commit: COMMIT, committedAt: at, worktree: root, sessionId: null };
      const rest = (repository.branches ?? []).map((b) => ({ name: b.name, commit: COMMIT, committedAt: b.committedAt ?? at, worktree: b.worktree ?? null, sessionId: b.sessionId ?? null }));
      return [[root, [own, ...rest]]];
    }),
  );

  /** A requested directory as a request records it: `~` from the home. */
  const expanded = (path: string): string => (path === "~" ? options.home : path.replace(/^~\//, `${options.home}/`)).replace(/(.)\/+$/, "$1");
  /** The checkout holding `path`: itself or its nearest parent that is one. */
  const holding = (path: string): { readonly root: string; readonly repository: ScriptedRepository } | undefined => {
    for (let p: string | null = path; p !== null; p = parentOf(p)) {
      const repository = folders.get(p)?.repository;
      if (repository !== undefined) return { root: p, repository };
    }
    return undefined;
  };
  const error = (code: string, message: string, data: JsonObject = {}): FakeAnswer => ({ error: { code, message, data } });

  return {
    browse(params) {
      const path = typeof params["path"] === "string" ? expanded(params["path"]) : options.home;
      if (!directories.has(path)) return error("not_found", `There is no directory ${path}.`, { kind: "directory" });
      const folder = folders.get(path);
      if (folder?.unreadable === true) return error("conflict", `The environment cannot list ${path}.`, { reason: "not_readable", path });
      const names = [...directories]
        .filter((d) => d !== path && parentOf(d) === path)
        .map(nameOf)
        .filter((name) => params["hidden"] === true || !name.startsWith("."))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const result: ResultOf<"workspaces.browse"> = {
        path,
        parent: parentOf(path),
        directories: names.map((name) => ({ name, repository: folders.get(childOf(path, name))?.repository !== undefined })),
        truncated: folder?.truncated === true,
      };
      return { result };
    },
    inspect(params) {
      const path = expanded(String(params["path"]));
      if (!directories.has(path)) return { result: { path, problem: "does_not_exist", repository: null } };
      if (folders.get(path)?.unreadable === true) return { result: { path, problem: "not_readable", repository: null } };
      const held = holding(path);
      if (held === undefined) return { result: { path, problem: null, repository: null } };
      const listed = branches.get(held.root) ?? [];
      const result: ResultOf<"workspaces.inspect"> = {
        path,
        problem: null,
        repository: {
          root: held.root,
          mainCheckout: held.root,
          bare: false,
          repositoryIdentity: held.repository.identity ?? null,
          branch: held.repository.branch ?? "main",
          head: { commit: COMMIT, committedAt: at },
          originHead: held.repository.originHead == null ? null : `origin/${held.repository.originHead}`,
          branches: listed,
          branchesTruncated: held.repository.branchesTruncated === true,
        },
      };
      return { result };
    },
    worktree(request, id) {
      const refused = (reason: string, message: string, data: JsonObject = {}) => ({ refused: { code: "conflict", message, data: { reason, ...data } } });
      const from = expanded(request.repository);
      const held = directories.has(from) ? holding(from) : undefined;
      if (held === undefined) return refused("not_a_repository", `${request.repository} is in no git repository.`, { path: request.repository });
      const repository = held.root;
      const listed = branches.get(repository) ?? [];
      const named = request.branch ?? request.newBranch?.name ?? `agent-harness/${id.slice(0, 8)}`;
      const found = listed.find((b) => b.name === named);
      if (request.branch !== undefined) {
        if (found === undefined) return refused("branch_not_found", `The repository ${repository} has no local branch ${named}.`, { repository, branch: named });
        if (found.worktree !== null) {
          const holder = found.sessionId === null ? {} : { sessionId: found.sessionId };
          return refused("branch_checked_out", `The branch ${named} is already checked out in ${found.worktree}; git checks a branch out in one worktree at a time.`, {
            repository,
            branch: named,
            worktree: found.worktree,
            ...holder,
          });
        }
      } else if (found !== undefined) {
        return refused("branch_exists", `The repository ${repository} already has a branch ${named}; ask for it as an existing branch, or name another.`, { repository, branch: named });
      }
      const path = `/data/worktrees/${nameOf(repository)}-0a1b2c3d/${named.replace(/\//g, "-")}`;
      const made = { name: named, commit: COMMIT, committedAt: options.now(), worktree: path, sessionId: id };
      branches.set(repository, found === undefined ? [made, ...listed] : listed.map((b) => (b.name === named ? made : b)));
      return { workspace: { kind: "worktree", path, repository, branch: named }, repositoryIdentity: held.repository.identity ?? null };
    },
  };
};

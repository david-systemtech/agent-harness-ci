import { constants, mkdirSync, rmSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ContractError, invalidParams, type ForgeAccountOrigins, type Workspace, type WorkspaceProblem, type WorkspaceRequest } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Undo } from "../serve/methods.js";
import { sessionNotFound, type Refusal } from "../sessions/decider.js";
import { readSummary, type Reader } from "../sessions/session-reads.js";
import { readRepositoryIdentity } from "./identity.js";
import { isInside } from "./paths.js";
import type { WorkspaceRoots } from "./roots.js";
import { makeWorktree } from "./worktrees.js";

/**
 * The resolver (workspace-picker spec, "The resolver"; #321): the one
 * in-process seam that turns a workspace request into the workspace a
 * session records and its repository identity, or a refusal. `sessions.create`
 * asks it in its `prepare`, outside the transaction, after the decider's
 * cheap refusals; the completions surface asks it for a fresh session; the
 * Carry over import (#88), minted sessions and routines (#92) and
 * `sessions.setWorkspace` will ask it too.
 *
 * What it makes for a request (a scratch directory, a worktree and its new
 * branch) it answers with an `undo` that removes exactly that, and nothing
 * that was there before it: the caller runs it when the command is not
 * accepted. Each kind (#325):
 *
 * - **Directory**: absolute, or from the environment's home (`~`, `~/`,
 *   `~\`); `.` and `..` resolved as written and symlinks kept, so the record
 *   is the path the client meant. One this operating system does not read
 *   as absolute is thrown `invalid_params`, as the wire's schema refuses a
 *   relative one. It is refused `conflict`, reason `workspace_unusable`, with
 *   its `problem` and path, when it does not exist, is not a directory, lies
 *   inside the data directory outside every workspace root (`reserved`,
 *   the path as written or as its links lead), or cannot be listed and
 *   entered (`not_readable`); else recorded with the identity git finds
 *   there (`identity.ts`, #324).
 * - **Scratch**: `<data dir>/scratch/<session id>`, made 0700, with no
 *   identity (no git is asked: nothing in the scratch root is a checkout).
 * - **Session**: the named session's recorded workspace and identity, shared
 *   as a fork shares them (ADR 0022); a session not here or deleted is
 *   `not_found` (kind `session`), and one whose workspace is gone `conflict`,
 *   reason `workspace_missing`. Nothing is made.
 * - **Worktree**: a worktree of the repository holding the requested path,
 *   made from its main checkout (or bare repository) on a new or existing
 *   branch under the worktrees root, locked for the session, with the
 *   ignored files its `.worktreeinclude` names copied in; refused with the
 *   reason git's answer gives (`worktrees.ts`, #326).
 */

/** What the resolver answers: the workspace and identity to record, with how to remove what it made; or a refusal. */
export type Resolution =
  | {
      readonly workspace: Workspace;
      readonly repositoryIdentity: string | null;
      /** Removes what resolving made, when the create it was for is not accepted; absent when it made nothing. */
      readonly undo?: Undo;
      readonly refused?: undefined;
    }
  | { readonly refused: Refusal };

export interface WorkspaceResolver {
  /**
   * Resolves `request` for the session `sessionId` (in lowercase), which a
   * worktree's branch and a scratch directory are named from. An answer it
   * has at once is given at once, not as a promise, so a create that needs
   * no wait keeps its place among its socket's requests (`serve/methods.ts`).
   */
  resolve(request: WorkspaceRequest, sessionId: string): Resolution | Promise<Resolution>;
}

/** What an environment's resolver reads beyond its data directory and log; each has a preset. */
export interface WorkspaceSettings {
  /** The roots later workstreams declare beside the data directory's scratch and worktrees (bank checkouts, #90); preset: none. */
  readonly roots?: readonly string[];
  /** The environment's home, which a directory request's `~` stands for. Preset: the running user's. */
  readonly home?: string;
  /**
   * Whether the environment's user can list and enter the directory at
   * `path`. Preset: the file system's access check. The environment never
   * runs as root (ADR 0006), which reads any directory, so a test running as
   * root scripts it.
   */
  readonly readable?: (path: string) => Promise<boolean>;
  /** How long each git call finding a repository identity or making a worktree gets; preset: the hardened runner's 15 seconds. */
  readonly gitTimeoutMs?: number;
}

export interface WorkspaceResolverOptions extends Omit<WorkspaceSettings, "roots"> {
  /** The log, whose session list a `session` request reads. */
  readonly log: EventLog;
  /** The data directory (absolute), reserved outside its workspace roots. */
  readonly dataDir: string;
  readonly roots: WorkspaceRoots;
  /** This environment's forge accounts with their verified aliases, as the identity rule reads them now (#329); preset: none. */
  readonly forgeAccounts?: () => readonly ForgeAccountOrigins[];
}

/** What each problem says of the directory at `path`. */
const PROBLEM_MESSAGES: Readonly<Record<WorkspaceProblem, (path: string) => string>> = {
  does_not_exist: (path) => `There is no directory ${path} on this environment.`,
  not_a_directory: (path) => `${path} is not a directory.`,
  not_readable: (path) => `The environment cannot list or enter ${path}.`,
  reserved: (path) => `${path} is inside the environment's data directory, where no session works outside a workspace root.`,
};

const unusable = (path: string, problem: WorkspaceProblem): Resolution => ({
  refused: { code: "conflict", message: PROBLEM_MESSAGES[problem](path), data: { reason: "workspace_unusable", problem, path } },
});

/** The errors a `stat` answers for a path with no directory there: nothing, a file on the way, a link loop, a name too long. */
const NOT_THERE = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** Whether the running user can list and enter the directory at `path`. */
const accessible = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether `path` is a directory now; a `stat` that fails is none. */
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** Whether paths compare without regard to case on this platform, as its file systems do by default. */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const folded = (path: string): string => (CASE_INSENSITIVE ? path.toLowerCase() : path);

/** Where `path`'s links lead; the path as written when they cannot be followed (a root not made yet). */
const followed = async (path: string): Promise<string> => realpath(path).catch(() => path);

/** The environment's resolver. */
export const createWorkspaceResolver = (options: WorkspaceResolverOptions): WorkspaceResolver => {
  const { dataDir, roots } = options;
  const home = options.home ?? homedir();
  const readable = options.readable ?? accessible;
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };

  /**
   * A requested directory as recorded: `~`, and `~/` or `~\` with what
   * follows, read from the environment's home (the wire's schema refuses any
   * other `~` form; an in-process caller's is not taken for a home), then
   * `.` and `..` resolved as written. Thrown `invalid_params` when this
   * operating system does not read it as absolute.
   */
  const recorded = (path: string): string => {
    const expanded = path === "~" ? home : /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path;
    if (!isAbsolute(expanded)) {
      const message = `A workspace directory is an absolute path on this environment, or one from its home (~); ${path} is not.`;
      throw new ContractError(invalidParams([{ code: "custom", path: ["workspace", "path"], message }], message));
    }
    return resolve(expanded);
  };

  /**
   * Whether `path` lies inside the data directory and outside every
   * workspace root, compared as written and as the links of each lead, so a
   * link from outside into the data directory is reserved too. A root itself
   * is reserved: it holds every session's directories, none of them its own.
   */
  const reserved = async (path: string): Promise<boolean> => {
    const inReserve = (at: string, data: string, rootsAt: readonly string[]): boolean => {
      const where = folded(at);
      return isInside(folded(data), where) && !rootsAt.map(folded).some((root) => where !== root && isInside(root, where));
    };
    if (inReserve(path, dataDir, roots.all)) return true;
    const [real, realData, realRoots] = await Promise.all([followed(path), followed(dataDir), Promise.all(roots.all.map(followed))]);
    return inReserve(real, realData, realRoots);
  };

  /** Why the directory at `path` cannot be a workspace, or null when it can; each problem kept apart. */
  const problemWith = async (path: string): Promise<WorkspaceProblem | null> => {
    try {
      if (!(await stat(path)).isDirectory()) return "not_a_directory";
    } catch (error) {
      return NOT_THERE.has(errorCode(error) ?? "") ? "does_not_exist" : "not_readable";
    }
    if (await reserved(path)) return "reserved";
    return (await readable(path)) ? null : "not_readable";
  };

  /**
   * The identity of the repository holding `path`, a verified alias's host
   * mapped to its forge account's canonical host; none when git gives none,
   * the create going on without one.
   */
  const identityAt = (path: string): Promise<string | null> =>
    readRepositoryIdentity(path, { forgeAccounts: options.forgeAccounts?.() ?? [], ...(options.gitTimeoutMs !== undefined && { timeoutMs: options.gitTimeoutMs }) });

  const directory = async (requested: string): Promise<Resolution> => {
    const path = recorded(requested);
    const problem = await problemWith(path);
    if (problem !== null) return unusable(path, problem);
    return { workspace: { kind: "directory", path }, repositoryIdentity: await identityAt(path) };
  };

  /** The session's own scratch directory, made 0700 and removed by the undo; one already there (its id's) is not this call's to remove. */
  const scratch = (sessionId: string): Resolution => {
    const path = join(roots.scratch, sessionId);
    const workspace: Workspace = { kind: "scratch", path };
    mkdirSync(roots.scratch, { recursive: true, mode: 0o700 });
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") return { workspace, repositoryIdentity: null };
      throw error;
    }
    return { workspace, repositoryIdentity: null, undo: () => rmSync(path, { recursive: true, force: true }) };
  };

  /** The named session's workspace and identity as it recorded them, while that workspace is there. */
  const shared = async (named: string): Promise<Resolution> => {
    const sessionId = named.toLowerCase();
    const source = readSummary(reader, sessionId);
    if (source === null) return { refused: sessionNotFound(sessionId) };
    const { workspace, repositoryIdentity } = source;
    if (!(await isDirectory(workspace.path))) {
      return {
        refused: {
          code: "conflict",
          message: `The workspace ${workspace.path} of the session ${sessionId} is not there.`,
          data: { reason: "workspace_missing", sessionId, path: workspace.path },
        },
      };
    }
    return { workspace, repositoryIdentity };
  };

  /** The session whose recorded workspace is the worktree at `path`: the first made there, a deleted one in its grace included. */
  const sessionAt = (path: string): string | null => {
    const [row] = reader.all<{ id: string }>(
      "SELECT id FROM sessions WHERE json_extract(workspace, '$.kind') = 'worktree' AND json_extract(workspace, '$.path') = ? ORDER BY created_at, id LIMIT 1",
      path,
    );
    return row?.id ?? null;
  };

  return {
    resolve: (request, sessionId) => {
      switch (request.kind) {
        case "directory":
          return directory(request.path);
        case "worktree":
          return makeWorktree(request, sessionId, {
            root: roots.worktrees,
            sessionAt,
            identityAt,
            ...(options.gitTimeoutMs !== undefined && { timeoutMs: options.gitTimeoutMs }),
          });
        case "scratch":
          return scratch(sessionId);
        case "session":
          return shared(request.sessionId);
      }
    },
  };
};

import { stat } from "node:fs/promises";
import {
  ENVIRONMENT_STREAM_KIND,
  SESSION_STREAM_KIND,
  forgeAccountOnHost,
  forgeOriginHost,
  type ForgeAccountOrigins,
  type RepositoryIdentifiedReason,
  type Workspace,
} from "@agent-harness/contracts";
import { formatActor, type EventEnvelope, type EventLog } from "../event-log/event-log.js";
import { readRepositoryIdentity } from "./identity.js";

/**
 * The identity passes (workspace-picker spec, "Repository identity",
 * Changes; #329): the two ways a session's repository identity changes after
 * its creation, each appending `session.repository-identified` as
 * `system:workspaces`, which sets the summary's identity and leaves
 * `updatedAt` where it was.
 *
 * - **Resolved**: after each start, once the wire is open, every session
 *   not deleted that has no identity and whose workspace is a directory or
 *   a worktree that is there now is resolved again by the rule the create
 *   used (`identity.ts`), four git processes at a time. One that now has an
 *   identity appends. So a session made before identities were resolved, a
 *   create whose git timed out, and a directory that has since gained a
 *   remote join the by-repository view. Scratch workspaces, which the
 *   completions surface makes by the thousand and in which nothing is a
 *   checkout, are skipped.
 * - **Alias**: when a forge account is added, or its aliases change (one
 *   verified later, as `system:forge`), every identity whose host is a
 *   verified alias of one forge account takes that account's canonical
 *   host: a string rewrite of the identity's host, which runs no git and
 *   needs no workspace. It matters because the Carry over import records
 *   identities before any forge account exists.
 *
 * The rule is given this environment's forge accounts with their verified
 * aliases as they are when it runs, and a resolved identity is put on its
 * canonical host again as it is appended, in case an alias was verified
 * while its git ran.
 */

/** Who the passes append as. */
export const WORKSPACES_ACTOR = formatActor({ kind: "system", id: "workspaces" });

/** How many git processes the resolved pass runs at once. */
const GIT_AT_ONCE = 4;

/** The workspace kinds the resolved pass asks git about: those that can be in a repository. */
const RESOLVED_KINDS: ReadonlySet<string> = new Set(["directory", "worktree"]);

export interface IdentityPassesOptions {
  readonly log: EventLog;
  /** This environment's forge accounts, each with its canonical origin and verified aliases, as the rule reads them now. */
  readonly forgeAccounts: () => readonly ForgeAccountOrigins[];
  /** How long each git call gets; preset: the hardened runner's 15 seconds. */
  readonly gitTimeoutMs?: number;
}

/** The passes as a start runs them. */
export interface RunningPasses {
  /** Settles once the resolved pass has run, or has stopped. */
  readonly resolved: Promise<void>;
  /** Stops both passes, starting no git call after this, and settles once the calls the resolved pass has running have answered. */
  stop(): Promise<void>;
}

export interface IdentityPasses {
  /** Runs the resolved pass in the background, and the alias pass on every forge event that adds an account or changes its aliases. */
  start(): RunningPasses;
}

/** An identity's host and path; the rule gives `https://<host>/<path>` and nothing else. */
const IDENTITY_PARTS = /^https:\/\/([^/]+)\/(.+)$/;

/**
 * `identity` with its host moved to the canonical host of the forge account
 * whose verified alias it is (the rule's host step, `forgeAccountOnHost`);
 * itself when its host is none, or is an account's canonical host already.
 */
export const onCanonicalHost = (identity: string, forgeAccounts: readonly ForgeAccountOrigins[]): string => {
  const [, host, path] = IDENTITY_PARTS.exec(identity) ?? [];
  if (host === undefined || path === undefined) return identity;
  const account = forgeAccountOnHost(host, forgeAccounts);
  return account === null ? identity : `https://${forgeOriginHost(account.origin)}/${path}`;
};

/** Whether there is a directory at `path` now. */
const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

export const createIdentityPasses = (options: IdentityPassesOptions): IdentityPasses => {
  const { log } = options;
  let stopped = false;

  /**
   * Appends the identity a pass found for the session, if the session is
   * still as the pass read it: not deleted, and holding `before` in the
   * workspace it was read in. Answers whether it appended.
   */
  const identify = (sessionId: string, workspace: string, before: string | null, repositoryIdentity: string, reason: RepositoryIdentifiedReason): boolean =>
    log.atomically((tx) => {
      const [row] = log.read<{ workspace: string; repository_identity: string | null; deleted_at: string | null }>(
        "SELECT workspace, repository_identity, deleted_at FROM sessions WHERE id = ?",
        sessionId,
      );
      if (row === undefined || row.deleted_at !== null || row.workspace !== workspace || row.repository_identity !== before) return false;
      log.append({ kind: SESSION_STREAM_KIND, id: sessionId }, [{ type: "session.repository-identified", payload: { repositoryIdentity, reason } }], {
        tx,
        actor: WORKSPACES_ACTOR,
      });
      return true;
    });

  /** The resolved pass: see the module comment. */
  const resolvedPass = async (): Promise<void> => {
    const candidates = log
      .read<{ id: string; workspace: string }>("SELECT id, workspace FROM sessions WHERE deleted_at IS NULL AND repository_identity IS NULL ORDER BY updated_at DESC, id")
      .filter((row) => RESOLVED_KINDS.has((JSON.parse(row.workspace) as Workspace).kind));
    const resolveNext = async (): Promise<void> => {
      for (let row = candidates.shift(); row !== undefined && !stopped; row = candidates.shift()) {
        const { path } = JSON.parse(row.workspace) as Workspace;
        if (!(await isDirectory(path))) continue;
        const identity = await readRepositoryIdentity(path, {
          forgeAccounts: options.forgeAccounts(),
          ...(options.gitTimeoutMs !== undefined && { timeoutMs: options.gitTimeoutMs }),
        });
        if (identity === null || stopped) continue;
        identify(row.id, row.workspace, null, onCanonicalHost(identity, options.forgeAccounts()), "resolved");
      }
    };
    await Promise.all(Array.from({ length: GIT_AT_ONCE }, resolveNext));
  };

  /** The alias pass: every identity put on its canonical host, as the forge accounts are now. */
  const aliasPass = (): void => {
    const forgeAccounts = options.forgeAccounts();
    const rows = log.read<{ id: string; workspace: string; repository_identity: string }>(
      "SELECT id, workspace, repository_identity FROM sessions WHERE deleted_at IS NULL AND repository_identity IS NOT NULL ORDER BY id",
    );
    for (const row of rows) {
      const rewritten = onCanonicalHost(row.repository_identity, forgeAccounts);
      if (rewritten !== row.repository_identity) identify(row.id, row.workspace, row.repository_identity, rewritten, "alias");
    }
  };

  /** Whether `event` adds a forge account or changes its aliases: what the alias pass runs on. */
  const changesAliases = (event: EventEnvelope): boolean =>
    event.streamKind === ENVIRONMENT_STREAM_KIND &&
    (event.type === "forge.account.added" || (event.type === "forge.account.updated" && Object.hasOwn(event.payload, "aliases")));

  return {
    start: () => {
      // Heard as the forge's event commits, so its answer reaches the client after the identities it moved.
      const unsubscribe = log.subscribe((event) => {
        if (stopped || !changesAliases(event)) return;
        try {
          aliasPass();
        } catch (error) {
          console.error(`The alias pass after ${event.type} failed:`, error);
        }
      });
      const resolved = resolvedPass().catch((error: unknown) => console.error("The identity pass after the start failed; the next start runs it again:", error));
      return {
        resolved,
        stop: async () => {
          stopped = true;
          unsubscribe();
          await resolved;
        },
      };
    },
  };
};

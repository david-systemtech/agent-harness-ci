import type { SessionSummary } from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { EventLog } from "../event-log/event-log.js";
import type { CommandAnswer, MethodHandler, MethodHandlers } from "../serve/methods.js";
import { sessionNotFound, type Refusal } from "../sessions/decider.js";
import { readSummary, type Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import type { AutoMemory } from "./auto-memory.js";
import type { AvailabilityWatcher } from "./availability.js";
import type { Resolution, WorkspaceResolver } from "./resolver.js";

/**
 * `sessions.setWorkspace` (workspace-picker spec, "Missing workspaces"; ADR
 * 0021; #328): a session whose workspace is missing is given another,
 * resolved from a request as a create's is (`resolver.ts`), with its
 * repository identity resolved afresh. It is a prepared command: its
 * `prepare` refuses what it can at once (a session not here, a run live),
 * has the availability watcher look at the session's workspace, refuses a
 * session whose workspace is there (`workspace_present`: its transcript
 * names paths in it, which would lie about another), and only then resolves
 * the request, so nothing is made for a command refused anyway; its handler
 * decides again in the transaction, and what `prepare` made goes when it
 * refuses. Accepted, it appends `session.workspace-set`, which clears the
 * mark and moves `updatedAt`; the adapter host hears it and stops the
 * session's kept provider process (reason `moved`), so the next run starts
 * in the new workspace, resuming the provider's conversation, which the
 * Claude adapter keys by the harness session, not the directory. Once it
 * has committed, the session's auto memory is carried from its old key to
 * the new one (`auto-memory.ts`).
 */

export interface SetWorkspaceOptions {
  readonly log: EventLog;
  /** Whether a run of the session is live, as a start counts one. */
  readonly host: Pick<AdapterHost, "runActive">;
  /** What the request is resolved with: the one `sessions.create` asks. */
  readonly resolver: WorkspaceResolver;
  /** What looks at the session's workspace before the command decides. */
  readonly availability: Pick<AvailabilityWatcher, "check">;
  /** Where a session whose key the move changes has its auto memory carried. */
  readonly autoMemory: AutoMemory;
}

type Answer = CommandAnswer<{ summary: SessionSummary }, Refusal["code"]>;

/** A session as the command finds it: as it stands, or why it cannot be given a workspace. */
type Movable = { readonly summary: SessionSummary; readonly refused?: undefined } | { readonly refused: Refusal };

export const setWorkspaceMethods = (options: SetWorkspaceOptions): MethodHandlers => {
  const { log, host, resolver, availability, autoMemory } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The session, or why it cannot be given a workspace: not here or deleted, or a run live. */
  const idle = (id: string): Movable => {
    const summary = readSummary(reader, id);
    if (summary === null) return { refused: sessionNotFound(id) };
    const live = host.runActive(id);
    if (live === null) return { summary };
    return {
      refused: {
        code: "conflict",
        message: `A run of the session ${id} is live; let it end, or interrupt it, before giving the session another workspace.`,
        data: { reason: "run_active", sessionId: id, runId: live.runId },
      },
    };
  };

  /**
   * The session, or why it cannot be given a workspace now: `idle`'s
   * refusals, or its workspace not marked missing. Read in a command's
   * transaction, it reads that transaction.
   */
  const movable = (id: string): Movable => {
    const found = idle(id);
    if (found.refused !== undefined || found.summary.workspaceMissingSince !== null) return found;
    const { path } = found.summary.workspace;
    return {
      refused: {
        code: "conflict",
        message: `The workspace ${path} of the session ${id} is there; a session is given another only while its own is missing.`,
        data: { reason: "workspace_present", sessionId: id, path },
      },
    };
  };

  return {
    "sessions.setWorkspace": {
      prepare: (params, context) => {
        const id = params.sessionId.toLowerCase();
        const aggregate = sessionStream(id);
        const refused = (refusal: Refusal) => (): Answer => ({ aggregate, rejected: refusal });
        // A session not here or deleted, or a run live, is refused at once, keeping the command's place on its socket.
        const early = idle(id);
        if (early.refused !== undefined) return refused(early.refused);

        const moveTo = (resolved: Resolution): MethodHandler<"sessions.setWorkspace"> => {
          if (resolved.refused !== undefined) return refused(resolved.refused);
          if (resolved.undo !== undefined) context.onUndo(resolved.undo);
          const { workspace, repositoryIdentity } = resolved;
          return (_params, command): Answer => {
            const now = movable(id);
            if (now.refused !== undefined) return { aggregate, rejected: now.refused };
            const before = now.summary;
            log.append(aggregate, [{ type: "session.workspace-set", payload: { workspace, repositoryIdentity } }], {
              tx: command.tx,
              actor: command.actor,
              commandId: command.commandId,
            });
            // The old key's memory follows the session to its new key, once the move has committed.
            command.tx.afterCommit(
              () => void autoMemory.carry({ workspace: before.workspace, repositoryIdentity: before.repositoryIdentity }, { workspace, repositoryIdentity }),
            );
            const after = readSummary(reader, id);
            if (after === null) throw new Error(`The session ${id} is not in the list after its workspace was set.`);
            return { aggregate, result: { summary: after } };
          };
        };

        // The watcher looks first, so a workspace found gone is marked and one found back is refused.
        return availability.check(id).then(async () => {
          const now = movable(id);
          if (now.refused !== undefined) return refused(now.refused);
          return moveTo(await resolver.resolve(params.workspace, id));
        });
      },
    },
  };
};

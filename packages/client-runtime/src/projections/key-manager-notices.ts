import { EnvironmentNotice, type EventEnvelope, type KeyManagerConnectionRecord, type KeyManagerStatus, type KeyManagerStatusKind } from "@agent-harness/contracts";
import type { NoticeInput, Notices, StepAction } from "../notices.js";
import { createNamedRows } from "./named-rows.js";

/**
 * The key managers' rows in `projections.notices` (key-managers spec,
 * "Events and notices"; ADR 0011, "a failed verification raises a client
 * notice"; #384): a connection coming to stand in a status that needs David
 * raises one, naming the environment and the connection, with the status's
 * own line, and offering the Key manager step on that environment. Only
 * news raises one; heard as history (a replay onto a stream that held
 * nothing), an event raises none, but is still read for the connection's
 * label and status.
 *
 * - **A status that needs David** is any but `signed-in` (and `signing-in`,
 *   which is held in memory while a sign-in runs and never recorded): one
 *   awaiting a sign-in, rejected, expired, unreachable, sealed or with its
 *   certificate rejected. A return to `signed-in` asks for nothing.
 * - **A change** is a status on `key-manager.connection.added`, on
 *   `key-manager.connection.signed-in` (the environment's own sign-in from
 *   the kept credential may fail) or on `key-manager.connection.verified`
 *   whose kind differs from the kind this runtime last heard for that
 *   connection, none heard counting as another: the environment keeps a
 *   status of the kind there was, since-time and all, and records a
 *   verification that changed something else beside it. So a copy or an
 *   import added awaiting its sign-in asks for it once there.
 * - **A sign-out** (`key-manager.connection.signed-out`) raises none: only
 *   a person's command signs out, and the connection awaiting a sign-in is
 *   what they asked for. Its status is still heard.
 * - **A removal** (`key-manager.connection.removed`) withdraws every row
 *   this runtime raised about the connection, in its turn behind the rows
 *   heard before it: what they asked of David went with it (#1851).
 *
 * A row names its connection by its label, which the add and a relabelling
 * (`key-manager.connection.updated`) give: the labels heard are kept per
 * environment beside the request cache's `keyManagers.list`, and one known
 * to neither is read with `keyManagers.list` once the connection is ready
 * (`named-rows.ts`). One the answer does not name is "A key manager".
 */

/** What a key-manager notice offers: the Key manager step on its environment. */
export const KEY_MANAGER_NOTICE_ACTION: StepAction = "setup.key-manager";

/** The statuses that ask nothing of David: signed in, or on the way to it. */
const WORKING: ReadonlySet<KeyManagerStatusKind> = new Set<KeyManagerStatusKind>(["signed-in", "signing-in"]);

export interface KeyManagerNoticesHost {
  readonly notices: Notices;
  /** The environment's name now, as its record has it. */
  readonly name: (environmentId: string) => string;
  /** The connections the request cache holds for the environment, if it holds them; never fetches. */
  readonly held: (environmentId: string) => readonly KeyManagerConnectionRecord[] | null;
  /** Reads the environment's connections once its connection is ready; null when it could not. */
  readonly list: (environmentId: string) => Promise<readonly KeyManagerConnectionRecord[] | null>;
  readonly report: (error: unknown) => void;
}

export interface KeyManagerNotices {
  /** Reads a key-manager event on the environment's stream, and raises what it says when it is `news`. */
  heard(environmentId: string, event: EventEnvelope, news: boolean): void;
  /** Lets go of what is known of an environment's connections: it was removed. A row waiting for its label is raised no more. */
  forget(environmentId: string): void;
  close(): void;
}

export const createKeyManagerNotices = (host: KeyManagerNoticesHost): KeyManagerNotices => {
  /** Each connection's status kind as last heard, per environment. A connection never heard of is not here. */
  const statuses = new Map<string, Map<string, KeyManagerStatusKind>>();
  /** The ids of the rows raised about each connection, per environment, which its removal withdraws. */
  const raisedRows = new Map<string, Map<string, string[]>>();
  let closed = false;
  const rows = createNamedRows({
    notices: host.notices,
    draft: (message): NoticeInput => ({ kind: "key-manager", message, action: KEY_MANAGER_NOTICE_ACTION }),
    held: (environmentId, connectionId) => host.held(environmentId)?.find((connection) => connection.id === connectionId)?.label ?? null,
    list: async (environmentId) => {
      const connections = await host.list(environmentId);
      return connections === null ? null : new Map(connections.map((connection) => [connection.id, connection.label]));
    },
    report: host.report,
  });

  const statusesOf = (environmentId: string): Map<string, KeyManagerStatusKind> => {
    let held = statuses.get(environmentId);
    if (held === undefined) statuses.set(environmentId, (held = new Map()));
    return held;
  };

  /** Notes a connection's status as heard, and says it when it is news, needs David and is of another kind than the one heard before. */
  const statusHeard = (environmentId: string, connectionId: string, status: KeyManagerStatus, news: boolean): void => {
    const heard = statusesOf(environmentId);
    const before = heard.get(connectionId);
    heard.set(connectionId, status.kind);
    if (!news || WORKING.has(status.kind) || before === status.kind) return;
    rows.say(environmentId, connectionId, (label) => `${label ?? "A key manager"} on ${host.name(environmentId)}: ${status.message}`, (raised) => {
      let held = raisedRows.get(environmentId);
      if (held === undefined) raisedRows.set(environmentId, (held = new Map()));
      held.set(connectionId, [...(held.get(connectionId) ?? []), raised.id]);
    });
  };

  /** Withdraws the rows raised about a removed connection, once every row heard before the removal is raised. */
  const removed = (environmentId: string, connectionId: string): void =>
    rows.inTurn(environmentId, () => {
      const ids = raisedRows.get(environmentId)?.get(connectionId) ?? [];
      raisedRows.get(environmentId)?.delete(connectionId);
      if (ids.length > 0) host.notices.retire((raised) => ids.includes(raised.id));
    });

  return {
    heard(environmentId, event, news) {
      if (closed || !event.type.startsWith("key-manager.connection.")) return;
      const parsed = EnvironmentNotice.safeParse(event);
      if (!parsed.success) return;
      const notice = parsed.data;
      switch (notice.type) {
        case "key-manager.connection.added": {
          const { connectionId, label, status } = notice.payload;
          rows.named(environmentId, connectionId, label);
          return statusHeard(environmentId, connectionId, status, news);
        }
        case "key-manager.connection.signed-in":
        case "key-manager.connection.verified": {
          const { connectionId, status } = notice.payload;
          return statusHeard(environmentId, connectionId, status, news);
        }
        case "key-manager.connection.signed-out": {
          const { connectionId, status } = notice.payload;
          statusesOf(environmentId).set(connectionId, status.kind);
          return;
        }
        case "key-manager.connection.updated": {
          const { connectionId, label } = notice.payload;
          if (label !== undefined) rows.named(environmentId, connectionId, label);
          return;
        }
        // Heard as history too: it withdraws only a row this runtime raised, and history raises none. An id is never used
        // again, so what is known of the removed connection is kept, for a row still waiting behind its label.
        case "key-manager.connection.removed":
          return removed(environmentId, notice.payload.connectionId);
        // Ticks and a base path change no status.
        default:
          return;
      }
    },
    forget(environmentId) {
      statuses.delete(environmentId);
      raisedRows.delete(environmentId);
      rows.forget(environmentId);
    },
    close() {
      closed = true;
      statuses.clear();
      raisedRows.clear();
      rows.close();
    },
  };
};

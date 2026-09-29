import { ENVIRONMENT_STREAM_KIND, type KeyManagerMovedPayload, type KeyManagerMoveItemKind, type KeyManagerStoredValueDeletedPayload } from "@agent-harness/contracts";
import type { Projector } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The stored values Moves left behind (key-managers spec, "Move stored
 * tokens"; #371): one row for each whose delete failed after its item was
 * swapped to a reference, kept from `key-manager.moved` naming it
 * `undeleted` and let go by the `key-manager.stored-value-deleted` a later
 * start appends once it is deleted; rebuilt from the log.
 */

export const KEY_MANAGER_MOVES_PROJECTOR = "key-manager-moves";

export const KEY_MANAGER_MOVES_TABLES = {
  key_manager_left_behind: `CREATE TABLE key_manager_left_behind (
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    stored_at TEXT NOT NULL,
    PRIMARY KEY (kind, item_id, stored_at)
  ) STRICT`,
} as const;

/** Keeps the stored values left behind from the environment stream's Move events. */
export const keyManagerMovesProjector: Projector = {
  name: KEY_MANAGER_MOVES_PROJECTOR,
  tables: KEY_MANAGER_MOVES_TABLES,
  apply(event, db) {
    if (event.streamKind !== ENVIRONMENT_STREAM_KIND) return;
    if (event.type === "key-manager.moved") {
      const { item, undeleted } = event.payload as KeyManagerMovedPayload;
      if (undeleted !== null) db.run("INSERT OR IGNORE INTO key_manager_left_behind (kind, item_id, stored_at) VALUES (?, ?, ?)", item.kind, item.id, undeleted);
    } else if (event.type === "key-manager.stored-value-deleted") {
      const { item, storedAt } = event.payload as KeyManagerStoredValueDeletedPayload;
      db.run("DELETE FROM key_manager_left_behind WHERE kind = ? AND item_id = ? AND stored_at = ?", item.kind, item.id, storedAt);
    }
  },
};

/** A stored value a Move left behind: the item that held it, and where its owner keeps it. */
export interface LeftBehind {
  readonly kind: KeyManagerMoveItemKind;
  readonly itemId: string;
  readonly storedAt: string;
}

/** Every stored value Moves left behind, oldest first. */
export const leftBehind = (reader: Reader): LeftBehind[] =>
  reader.all<{ kind: KeyManagerMoveItemKind; item_id: string; stored_at: string }>("SELECT kind, item_id, stored_at FROM key_manager_left_behind ORDER BY rowid").map((row) => ({
    kind: row.kind,
    itemId: row.item_id,
    storedAt: row.stored_at,
  }));

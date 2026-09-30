import {
  CHROME_STREAM_KIND,
  ENVIRONMENT_STREAM_KIND,
  type ChromePairedPayload,
  type ChromeRenamedPayload,
  type ChromeUpdatedPayload,
  type ChromeVersionReportedPayload,
} from "@agent-harness/contracts";
import type { Projector, StreamRef } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-tables.js";

/**
 * The paired Chromes' read model (browser spec, "The extension, its folder
 * and its listener"; ADR 0014, ADR 0024; #548): a projector over the
 * `chrome` streams, one per Chrome, whose id is the Chrome's, kept in the
 * transaction that appends each event and rebuilt from the log. One row per
 * paired Chrome: its name, when it paired, when it last connected and the
 * extension version it last reported. An unpaired Chrome's row is removed;
 * its id, a UUID, is never minted again.
 *
 * A connection appends nothing to the Chrome's stream unless it reports
 * another version: the last connection time is read from the
 * `chrome.updated` notice every connection raises on the environment
 * stream, and a pairing, whose socket is the Chrome's first connection,
 * sets it too. Its secret is never here: the vault holds it.
 */

export const CHROMES_PROJECTOR = "chromes";

export const CHROMES_TABLES = {
  chromes: `CREATE TABLE chromes (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    last_connected_at TEXT NOT NULL,
    last_reported_version TEXT NOT NULL
  ) STRICT`,
} as const;

export const chromesProjector: Projector = {
  name: CHROMES_PROJECTOR,
  tables: CHROMES_TABLES,
  apply(event, db) {
    if (event.streamKind === ENVIRONMENT_STREAM_KIND && event.type === "chrome.updated") {
      const { chromeId, change } = event.payload as ChromeUpdatedPayload;
      if (change === "connected") db.run("UPDATE chromes SET last_connected_at = ? WHERE id = ?", event.occurredAt, chromeId);
      return;
    }
    if (event.streamKind !== CHROME_STREAM_KIND) return;
    switch (event.type) {
      case "chrome.paired": {
        const { name, extensionVersion } = event.payload as ChromePairedPayload;
        db.run(
          "INSERT INTO chromes (id, position, name, paired_at, last_connected_at, last_reported_version) VALUES (?, ?, ?, ?, ?, ?)",
          event.streamId,
          event.sequence,
          name,
          event.occurredAt,
          event.occurredAt,
          extensionVersion,
        );
        return;
      }
      case "chrome.renamed":
        return void db.run("UPDATE chromes SET name = ? WHERE id = ?", (event.payload as ChromeRenamedPayload).name, event.streamId);
      case "chrome.version-reported":
        return void db.run("UPDATE chromes SET last_reported_version = ? WHERE id = ?", (event.payload as ChromeVersionReportedPayload).extensionVersion, event.streamId);
      case "chrome.unpaired":
        return void db.run("DELETE FROM chromes WHERE id = ?", event.streamId);
    }
  },
};

/** A paired Chrome's stream. */
export const chromeStream = (chromeId: string): StreamRef => ({ kind: CHROME_STREAM_KIND, id: chromeId });

/** A paired Chrome as the projection holds it: what the list answers beside its live state. */
export interface ChromeRecord {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: string;
  readonly lastConnectedAt: string;
  readonly lastReportedVersion: string;
}

interface ChromeRow {
  readonly id: string;
  readonly name: string;
  readonly paired_at: string;
  readonly last_connected_at: string;
  readonly last_reported_version: string;
}

const recordOf = (row: ChromeRow): ChromeRecord => ({
  id: row.id,
  name: row.name,
  pairedAt: row.paired_at,
  lastConnectedAt: row.last_connected_at,
  lastReportedVersion: row.last_reported_version,
});

const SELECT = "SELECT id, name, paired_at, last_connected_at, last_reported_version FROM chromes";

/** Every paired Chrome, the first paired first. Inside a command, as of its transaction. */
export const readChromes = (reader: Reader): ChromeRecord[] => reader.all<ChromeRow>(`${SELECT} ORDER BY position`).map(recordOf);

/** The paired Chrome `chromeId` names; undefined for one this environment does not hold. */
export const readChrome = (reader: Reader, chromeId: string): ChromeRecord | undefined => {
  const [row] = reader.all<ChromeRow>(`${SELECT} WHERE id = ?`, chromeId.toLowerCase());
  return row === undefined ? undefined : recordOf(row);
};

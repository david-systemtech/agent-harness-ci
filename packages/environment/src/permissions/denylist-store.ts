import { isDeepStrictEqual } from "node:util";
import {
  ACCESS_STREAM_KIND,
  DENYLIST_SECTIONS,
  Denylist,
  DenylistChangedPayload,
  denylistPresets,
  type DenylistEntry,
  type DenylistSection,
} from "@agent-harness/contracts";
import { type EventEnvelope, type EventLog, type ProjectionDb, type StreamRef } from "../event-log/event-log.js";
import type { Reader } from "../sessions/session-reads.js";
import { PERMISSIONS_ACTOR } from "./actor.js";

/**
 * The denylist's read model (#132; permissions spec, "The denylist"): each
 * section as the latest `denylist.changed` on the access stream left it,
 * which carries the section after the change. The access log is where a
 * change is recorded (the spec's `access.denylist.changed`), and with the
 * section after it there it is also what the list is read from: one event
 * per change, and a rebuild replays it. Part of the permissions projector.
 *
 * The presets are seeded on first start (`seedDenylist`): one
 * `denylist.changed` per section that has presets, by the environment.
 * Seeded once: a section a person emptied stays empty after a restart.
 */

export const DENYLIST_TABLES = {
  denylist_sections: `CREATE TABLE denylist_sections (
    section TEXT PRIMARY KEY,
    entries TEXT NOT NULL
  ) STRICT`,
} as const;

/**
 * Keeps a section as its `denylist.changed` left it. A malformed payload,
 * or a section whose entries break its own grammar (a relative path, a URL
 * as a host), fails its append, whoever appends it, so the gate never reads
 * an entry the methods would refuse.
 */
export const projectDenylist = (event: EventEnvelope, db: ProjectionDb): void => {
  if (event.streamKind !== ACCESS_STREAM_KIND || event.type !== "denylist.changed") return;
  const { section, entries: given } = DenylistChangedPayload.parse(event.payload);
  const entries = Denylist.shape[section].parse(given);
  db.run(
    "INSERT INTO denylist_sections (section, entries) VALUES (?, ?) ON CONFLICT (section) DO UPDATE SET entries = excluded.entries",
    section,
    JSON.stringify(entries),
  );
};

/** The denylist as the environment holds it: a section never changed holds nothing. */
export const readDenylist = (reader: Reader): Denylist => {
  const rows = reader.all<{ section: string; entries: string }>("SELECT section, entries FROM denylist_sections");
  const held = new Map(rows.map((row) => [row.section, JSON.parse(row.entries) as DenylistEntry[]]));
  return Object.fromEntries(DENYLIST_SECTIONS.map((section) => [section, held.get(section) ?? []])) as Denylist;
};

/** How many entries each section holds, enabled or not (`permissions.settings.get`). */
export const denylistCounts = (denylist: Denylist): Record<DenylistSection, number> =>
  Object.fromEntries(DENYLIST_SECTIONS.map((section) => [section, denylist[section].length])) as Record<DenylistSection, number>;

/** Whether the presets were ever seeded: any section has been recorded. */
const seeded = (reader: Reader): boolean => reader.all("SELECT 1 FROM denylist_sections LIMIT 1").length > 0;

/**
 * One section's change: what was added, removed and edited between `before`
 * and `after`, by id, and the section after; null when nothing changed
 * (order included).
 */
export const sectionChange = (section: DenylistSection, before: readonly DenylistEntry[], after: readonly DenylistEntry[]): DenylistChangedPayload | null => {
  if (isDeepStrictEqual(before, after)) return null;
  const beforeById = new Map(before.map((entry) => [entry.id, entry]));
  const afterIds = new Set(after.map((entry) => entry.id));
  return {
    section,
    added: after.filter((entry) => !beforeById.has(entry.id)),
    removed: before.filter((entry) => !afterIds.has(entry.id)),
    edited: after.flatMap((entry) => {
      const previous = beforeById.get(entry.id);
      return previous !== undefined && !isDeepStrictEqual(previous, entry) ? [{ before: previous, after: entry }] : [];
    }),
    entries: [...after],
  };
};


/**
 * Seeds the presets on first start, for an environment whose data directory
 * is `dataDir`: one `denylist.changed` per section with presets, in one
 * transaction, before any run can be gated. Nothing once any section has
 * been recorded.
 */
export const seedDenylist = (options: { readonly log: EventLog; readonly stream: StreamRef; readonly dataDir: string }): void => {
  const { log } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  log.atomically((tx) => {
    if (seeded(reader)) return;
    const presets = denylistPresets(options.dataDir);
    const events = DENYLIST_SECTIONS.flatMap((section) => {
      const change = sectionChange(section, [], presets[section]);
      return change === null ? [] : [{ type: "denylist.changed", payload: change }];
    });
    log.append(options.stream, events, { tx, actor: PERMISSIONS_ACTOR });
  });
};

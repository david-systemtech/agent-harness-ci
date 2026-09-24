import { derived, type Observable } from "../observable.js";
import type { SessionListView, SessionRow } from "./session-list.js";

/**
 * `projections.search(query)` (docs/specs/client-runtime.md, "Projections"):
 * a case-insensitive substring match over each session's title, tags, the
 * name of its group and its repository identity, and nothing else (not the
 * draft, not the transcript: transcript search is a later milestone). The
 * query is trimmed; an empty one matches every session. Matches come in the
 * sidebar's order: pinned, active, snoozed, settled, archived.
 */

const matches = (row: SessionRow, needle: string): boolean =>
  [row.summary.title, ...row.summary.tags, row.groupName, row.summary.repositoryIdentity].some(
    (text) => text !== null && text.toLowerCase().includes(needle),
  );

export const searchRows = (view: SessionListView, query: string): readonly SessionRow[] => {
  const needle = query.trim().toLowerCase();
  return [...view.pinned, ...view.active, ...view.snoozed, ...view.settled, ...view.archived].filter((row) => matches(row, needle));
};

export const searchProjection = (list: Observable<SessionListView>, query: string): Observable<readonly SessionRow[]> =>
  derived([list], (view) => searchRows(view, query));

import type { EnvironmentView, SessionListView, SessionRow } from "@agent-harness/client-runtime";
import type { CollapsedHeadings } from "../presentation.js";
import { headingState, nameOf } from "../view.js";
import { badgesOf, glyphOf, type Badge, type Glyph } from "./badge.js";
import { wakeWords } from "./when.js";

/**
 * The rail's lines (docs/specs/tui.md, "The rail: a projection of the
 * session list"): a pure function of `projections.sessionList`,
 * `projections.environments` and the fold state, holding nothing of its
 * own. Headings, in order: pinned, merged across environments by
 * `pinOrderKey` then `pinnedAt`; one per merged group (the runtime's merge
 * and order); each environment's ungrouped active sessions under its name,
 * with its state ("unreachable since") and its waiting commands; the
 * snoozed shelf with wake times; the settled shelf; the archive. The
 * shelves and groups come in the runtime's sort; a pinned, snoozed, settled
 * or archived session is on its shelf whatever group it is in, so every
 * session is on one line.
 */

export type HeadingKind = "pinned" | "group" | "environment" | "snoozed" | "settled" | "archive";

/** What a row's `Shift+↑` and `Shift+↓` move it within: the pinned block or one heading's active sessions, or a shelf with no manual order. */
export type SectionKind = "pinned" | "active" | "snoozed" | "settled" | "archived";

export interface RailSection {
  readonly kind: SectionKind;
  /** Its sessions as rendered, before any filter. */
  readonly rows: readonly SessionRow[];
}

export interface RailHeading {
  readonly kind: "heading";
  /** The heading's name as `collapsedHeadings` keys it: `shelf:pinned`, `group:<name key>`, `environment:<id>`, `shelf:snoozed`, `shelf:settled`, `shelf:archive`. */
  readonly key: string;
  readonly heading: HeadingKind;
  readonly text: string;
  /** The sessions under it, before any filter. */
  readonly count: number;
  /** Null for an environment's heading, whose Enter starts a session rather than folding it. */
  readonly folded: boolean | null;
  /** A command about one of its groups waits for its receipt, or, while it is folded, one about a session under it. */
  readonly pending: boolean;
  /** Its environment cannot be reached (an environment's heading). */
  readonly dim: boolean;
  readonly environmentId: string | null;
  /** How many commands wait in the outbox for the environment (an environment's heading). */
  readonly pendingCommands: number;
}

export interface RailRow {
  readonly kind: "row";
  /** `<environment id>/<session id>`: a session is on one line. */
  readonly key: string;
  readonly row: SessionRow;
  readonly section: RailSection;
  readonly badge: Badge;
  readonly glyph: Glyph;
  readonly tags: readonly string[];
  /** Its environment cannot be reached: the row is the cached snapshot's. */
  readonly dim: boolean;
  /** A command about it waits for its receipt. */
  readonly pending: boolean;
  /** When a snoozed session comes back, in short words. */
  readonly wake: string | null;
}

/** A line nothing is done on: an environment's state, "no sessions", a list that failed. */
export interface RailNote {
  readonly kind: "note";
  readonly key: string;
  readonly text: string;
}

export type RailLine = RailHeading | RailRow | RailNote;

export interface RailInput {
  readonly list: SessionListView;
  /** Every environment listed, in the connection list's order: the headings and the badges. */
  readonly environments: readonly EnvironmentView[];
  readonly folded: CollapsedHeadings;
  /** The rows the filter matches (`rowKey`); null while there is no filter. */
  readonly matches: ReadonlySet<string> | null;
  /** Rows a command this terminal sent is still waiting on (`rowKey`), whatever the connection's phase. */
  readonly unconfirmed: ReadonlySet<string>;
  /** The local environment's service is being started from here. */
  readonly startingService: boolean;
  /** Each environment's now, from the server-time skew. */
  readonly now: (environmentId: string) => Date;
  /** Every heading open whatever the fold: to find which heading a row is under. */
  readonly open?: boolean;
}

export const rowKey = (row: Pick<SessionRow, "environmentId" | "summary">): string => `${row.environmentId}/${row.summary.id}`;

export const PINNED_HEADING = "shelf:pinned";
export const SNOOZED_HEADING = "shelf:snoozed";
export const SETTLED_HEADING = "shelf:settled";
export const ARCHIVE_HEADING = "shelf:archive";
export const groupHeading = (nameKey: string): string => `group:${nameKey}`;
export const environmentHeading = (environmentId: string): string => `environment:${environmentId}`;

/** A heading's fold: as `collapsedHeadings` names it, else the default (the settled shelf and the archive folded). */
export const isFolded = (folded: CollapsedHeadings, key: string): boolean => folded[key] ?? (key === SETTLED_HEADING || key === ARCHIVE_HEADING);

/** An environment whose rows are the environment's word now, not the cached snapshot's. */
export const isReachable = (view: EnvironmentView | undefined): boolean => view?.phase === "ready" || view?.phase === "syncing";

export const railLines = (input: RailInput): RailLine[] => {
  const { list, matches } = input;
  const badges = badgesOf(input.environments);
  const views = new Map(input.environments.map((v) => [v.environmentId, v]));
  const pendingRow = (row: SessionRow) => row.pending || input.unconfirmed.has(rowKey(row));
  const lines: RailLine[] = [];

  const rowLine = (row: SessionRow, section: RailSection): RailRow => ({
    kind: "row",
    key: rowKey(row),
    row,
    section,
    badge: badges.get(row.environmentId) ?? { icon: "●", abbreviation: "??", colour: "gray" },
    glyph: glyphOf(row.summary),
    tags: row.summary.tags,
    dim: !isReachable(views.get(row.environmentId)),
    pending: pendingRow(row),
    wake: section.kind === "snoozed" && row.summary.snoozedUntil !== null ? wakeWords(new Date(row.summary.snoozedUntil), input.now(row.environmentId)) : null,
  });

  /** A foldable heading and, unless folded, its rows; while filtering, only a heading with visible rows the filter matches. */
  const block = (fields: { key: string; heading: HeadingKind; text: string; pending?: boolean }, section: RailSection) => {
    const folded = input.open !== true && isFolded(input.folded, fields.key);
    const visible = matches === null ? section.rows : section.rows.filter((row) => matches.has(rowKey(row)));
    if (matches !== null && (folded || visible.length === 0)) return;
    lines.push({
      kind: "heading",
      ...fields,
      count: section.rows.length,
      folded,
      // A folded heading speaks for the rows it hides; an open one leaves it to them.
      pending: fields.pending === true || (folded && section.rows.some(pendingRow)),
      dim: false,
      environmentId: null,
      pendingCommands: 0,
    });
    if (!folded) lines.push(...visible.map((row) => rowLine(row, section)));
  };

  if (list.pinned.length > 0) block({ key: PINNED_HEADING, heading: "pinned", text: "Pinned" }, { kind: "pinned", rows: list.pinned });
  for (const group of list.groups) {
    if (group.shelves.active.length === 0) continue;
    block({ key: groupHeading(group.key), heading: "group", text: group.name, pending: group.pending }, { kind: "active", rows: group.shelves.active });
  }

  for (const view of input.environments) {
    const section: RailSection = { kind: "active", rows: list.active.filter((row) => row.environmentId === view.environmentId && row.groupName === null) };
    const visible = matches === null ? section.rows : section.rows.filter((row) => matches.has(rowKey(row)));
    if (matches !== null && visible.length === 0) continue;
    lines.push({
      kind: "heading",
      key: environmentHeading(view.environmentId),
      heading: "environment",
      text: nameOf(view),
      count: section.rows.length,
      folded: null,
      pending: view.pendingCommands > 0,
      dim: !isReachable(view),
      environmentId: view.environmentId,
      pendingCommands: view.pendingCommands,
    });
    if (matches === null) {
      const state = headingState(view, input.startingService);
      if (state !== undefined) lines.push({ kind: "note", key: `${view.environmentId}:state`, text: state });
      const fault = list.environments.find((e) => e.environmentId === view.environmentId)?.fault ?? null;
      if (fault !== null) lines.push({ kind: "note", key: `${view.environmentId}:fault`, text: `the list failed: ${fault}` });
      if (!list.rows.some((row) => row.environmentId === view.environmentId)) lines.push({ kind: "note", key: `${view.environmentId}:empty`, text: "no sessions" });
    }
    lines.push(...visible.map((row) => rowLine(row, section)));
  }

  if (list.snoozed.length > 0) block({ key: SNOOZED_HEADING, heading: "snoozed", text: "Snoozed" }, { kind: "snoozed", rows: list.snoozed });
  if (list.settled.length > 0) block({ key: SETTLED_HEADING, heading: "settled", text: "Settled" }, { kind: "settled", rows: list.settled });
  if (list.archived.length > 0) block({ key: ARCHIVE_HEADING, heading: "archive", text: "Archive" }, { kind: "archived", rows: list.archived });
  return lines;
};

/** The heading the line `key` names is under, whatever the folds; undefined for a line not listed, or not under a heading. */
export const headingOver = (input: RailInput, key: string): RailHeading | undefined => {
  const all = railLines({ ...input, matches: null, open: true });
  const at = all.findIndex((line) => line.key === key);
  return at === -1 ? undefined : all.slice(0, at).reverse().find((line): line is RailHeading => line.kind === "heading");
};

/** The lines the cursor stops on: headings and rows. */
export const isSelectable = (line: RailLine): line is RailHeading | RailRow => line.kind !== "note";

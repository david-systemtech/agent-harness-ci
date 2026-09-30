import type { SessionSummary } from "@agent-harness/contracts";
import type { EnvironmentView } from "../projections/environments.js";
import type { ListFreshness, MergedGroupHeading, SessionListView, SessionRow } from "../projections/session-list.js";
import { wakeWords } from "./when.js";

/**
 * The headings a session list is drawn under (docs/specs/tui.md, "The rail";
 * docs/specs/gui.md, "The window and the sidebar"), which the terminal UI's
 * rail and the window's sidebar both draw: a pure function of
 * `projections.sessionList`, `projections.environments` and the fold state,
 * holding nothing of its own. Headings, in order: pinned, merged across
 * environments by `pinOrderKey` then `pinnedAt`; one per merged group (the
 * runtime's merge and order, left out while it has no active session);
 * each environment's ungrouped active sessions under its name, every
 * environment having one; the snoozed shelf with wake times; the settled
 * shelf; the archive. A shelf is left out while empty. The shelves and
 * groups come in the runtime's sort; a pinned, snoozed, settled or archived
 * session is on its shelf whatever group it is in, so every session is on
 * one line. How each is drawn, and in what words, is each renderer's.
 */

/**
 * Which headings are folded, by heading name (`collapsedHeadings`, a
 * presentation key of each renderer): `true` folded, `false` open; a heading
 * not named takes its default (the settled shelf and the archive folded).
 */
export type CollapsedHeadings = Readonly<Record<string, boolean>>;

/** The pinned block is not a shelf (glossary: Shelf): its fold is keyed as a block. */
export const PINNED_HEADING = "block:pinned";
export const SNOOZED_HEADING = "shelf:snoozed";
export const SETTLED_HEADING = "shelf:settled";
export const ARCHIVE_HEADING = "shelf:archive";
/** A merged group's heading, by the group's name key (`groupNameKey`), so one fold holds across environments. */
export const groupHeading = (nameKey: string): string => `group:${nameKey}`;
/** An environment's heading, which does not fold. */
export const environmentHeading = (environmentId: string): string => `environment:${environmentId}`;

/** A heading's fold: as `collapsedHeadings` names it, else the default (the settled shelf and the archive folded). */
export const isFolded = (folded: CollapsedHeadings, key: string): boolean => folded[key] ?? (key === SETTLED_HEADING || key === ARCHIVE_HEADING);

/**
 * Which folds to keep as another is kept: every heading's but a merged
 * group's the list no longer holds, so the folds of groups long gone do not
 * pile up.
 */
export const keepsFold = (list: Pick<SessionListView, "groups">): ((heading: string) => boolean) => {
  const groups = new Set(list.groups.map((group) => groupHeading(group.key)));
  return (heading) => !heading.startsWith(groupHeading("")) || groups.has(heading);
};

/** An environment whose rows are the environment's word now, not the cached snapshot's. */
export const isReachable = (view: EnvironmentView | undefined): boolean => view?.phase === "ready" || view?.phase === "syncing";

/** `<environment id>/<session id>`: a session is on one line. */
export const rowKey = (row: Pick<SessionRow, "environmentId" | "summary">): string => `${row.environmentId}/${row.summary.id}`;

/**
 * A row's activity: `parked` with the count of its parked prompts, else
 * `starting`, `running` or `idle`. A session with a parked prompt reads as
 * parked whatever its activity says, as the runtime's run states read it.
 */
export interface RowActivity {
  readonly state: "idle" | "starting" | "running" | "parked";
  /** Its parked prompts; 0 unless parked (a parked activity may say none yet). */
  readonly parked: number;
}

export const activityOf = (summary: Pick<SessionSummary, "activity" | "parkedPromptCount">): RowActivity => {
  if (summary.activity.state === "parked" || summary.parkedPromptCount > 0) return { state: "parked", parked: summary.parkedPromptCount };
  const { state } = summary.activity;
  return { state: state === "starting" || state === "running" ? state : "idle", parked: 0 };
};

export type HeadingKind = "pinned" | "group" | "environment" | "snoozed" | "settled" | "archive";

/**
 * The rows under one heading, which a manual move goes among: the pinned
 * block, one heading's active sessions, or a shelf (the snoozed, settled or
 * archived one), which has no manual order.
 */
export type BlockKind = "pinned" | "active" | "snoozed" | "settled" | "archived";

export interface SessionBlock {
  readonly kind: BlockKind;
  /** Its sessions as drawn, before any filter. */
  readonly rows: readonly SessionRow[];
}

/** One session as drawn under its heading. */
export interface HeadingRow {
  /** `rowKey`. */
  readonly key: string;
  readonly row: SessionRow;
  readonly block: SessionBlock;
  readonly activity: RowActivity;
  /** Its environment cannot be reached: the row is the cached snapshot's. */
  readonly dim: boolean;
  /** A command about it awaits its receipt: the runtime's `awaitingReceipt`, whatever the connection's phase. */
  readonly pending: boolean;
  /** When a snoozed session comes back, in short words on this client's calendar from its environment's now (`wakeWords`). */
  readonly wake: string | null;
}

interface HeadingOf<K extends HeadingKind> {
  readonly kind: K;
  /** The heading's name as `collapsedHeadings` keys it. */
  readonly key: string;
  readonly block: SessionBlock;
  /** The rows drawn under it: none while folded, and only those the filter matches while there is one. */
  readonly rows: readonly HeadingRow[];
}

/** The pinned block, a merged group or a shelf: headings that fold. */
export interface FoldingHeading extends HeadingOf<"pinned" | "group" | "snoozed" | "settled" | "archive"> {
  /** "Pinned", the group's merged name, "Snoozed", "Settled" or "Archive". */
  readonly text: string;
  readonly folded: boolean;
  /** A command about one of its groups awaits its receipt (the runtime's `awaitingReceipt`), or, while it is folded, one about a session under it. */
  readonly pending: boolean;
  /** A merged group's heading: the group, with the member group on each environment that a command about it targets; null for the pinned block and the shelves. */
  readonly group: MergedGroupHeading | null;
}

/** An environment's heading, over its ungrouped active sessions: it does not fold. */
export interface EnvironmentHeading extends HeadingOf<"environment"> {
  readonly environment: EnvironmentView;
  /** It cannot be reached: its rows are the cached snapshot's. */
  readonly dim: boolean;
  /** How current its list is, and why its subscription failed if it did; undefined for an environment not enabled. */
  readonly list: ListFreshness | undefined;
  /** It has no session at all, on any shelf. */
  readonly empty: boolean;
}

export type SessionHeading = FoldingHeading | EnvironmentHeading;

export interface HeadingsInput {
  readonly list: SessionListView;
  /** Every environment listed, in the connection list's order. */
  readonly environments: readonly EnvironmentView[];
  readonly folded: CollapsedHeadings;
  /** The rows the filter matches (`rowKey`); null while there is no filter. While there is one, only the headings with a matching row not folded away are drawn. */
  readonly matches: ReadonlySet<string> | null;
  /** Each environment's now, from the server-time skew (`runtime.environmentNow`). */
  readonly now: (environmentId: string) => Date;
  /** Every heading open whatever the fold: to find which heading a row is under. */
  readonly open?: boolean;
}

export const sessionHeadings = (input: HeadingsInput): SessionHeading[] => {
  const { list, matches } = input;
  const views = new Map(input.environments.map((v) => [v.environmentId, v]));
  const headings: SessionHeading[] = [];
  const shown = (rows: readonly SessionRow[]) => (matches === null ? rows : rows.filter((row) => matches.has(rowKey(row))));

  const rowOf = (row: SessionRow, block: SessionBlock): HeadingRow => ({
    key: rowKey(row),
    row,
    block,
    activity: activityOf(row.summary),
    dim: !isReachable(views.get(row.environmentId)),
    pending: row.awaitingReceipt,
    wake: block.kind === "snoozed" && row.summary.snoozedUntil !== null ? wakeWords(new Date(row.summary.snoozedUntil), input.now(row.environmentId)) : null,
  });

  /** A folding heading and, unless folded, its rows; while filtering, only one with rows the filter matches, open. */
  const folding = (kind: FoldingHeading["kind"], key: string, text: string, block: SessionBlock, group: MergedGroupHeading | null = null) => {
    const folded = input.open !== true && isFolded(input.folded, key);
    const visible = shown(block.rows);
    if (matches !== null && (folded || visible.length === 0)) return;
    headings.push({
      kind,
      key,
      text,
      block,
      rows: folded ? [] : visible.map((row) => rowOf(row, block)),
      folded,
      // A folded heading speaks for the rows it hides; an open one leaves it to them.
      pending: (group?.awaitingReceipt ?? false) || (folded && block.rows.some((row) => row.awaitingReceipt)),
      group,
    });
  };

  if (list.pinned.length > 0) folding("pinned", PINNED_HEADING, "Pinned", { kind: "pinned", rows: list.pinned });
  for (const group of list.groups) {
    if (group.shelves.active.length === 0) continue;
    folding("group", groupHeading(group.key), group.name, { kind: "active", rows: group.shelves.active }, group);
  }

  for (const view of input.environments) {
    const block: SessionBlock = { kind: "active", rows: list.active.filter((row) => row.environmentId === view.environmentId && row.groupName === null) };
    const visible = shown(block.rows);
    if (matches !== null && visible.length === 0) continue;
    headings.push({
      kind: "environment",
      key: environmentHeading(view.environmentId),
      block,
      rows: visible.map((row) => rowOf(row, block)),
      environment: view,
      dim: !isReachable(view),
      list: list.environments.find((e) => e.environmentId === view.environmentId),
      empty: !list.rows.some((row) => row.environmentId === view.environmentId),
    });
  }

  if (list.snoozed.length > 0) folding("snoozed", SNOOZED_HEADING, "Snoozed", { kind: "snoozed", rows: list.snoozed });
  if (list.settled.length > 0) folding("settled", SETTLED_HEADING, "Settled", { kind: "settled", rows: list.settled });
  if (list.archived.length > 0) folding("archive", ARCHIVE_HEADING, "Archive", { kind: "archived", rows: list.archived });
  return headings;
};

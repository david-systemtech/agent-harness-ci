import {
  sessionHeadings,
  type EnvironmentView,
  type HeadingKind,
  type HeadingRow,
  type HeadingsInput,
  type SessionHeading,
} from "@agent-harness/client-runtime";
import { headingState, nameOf } from "../view.js";
import { UNLISTED_BADGE, glyphOf, type Badge, type Glyph } from "./badge.js";

/**
 * The rail's lines (docs/specs/tui.md, "The rail: a projection of the
 * session list"): the client runtime's headings (`sessionHeadings`, which
 * the window's sidebar draws too), each followed by its rows, as lines a
 * cursor moves over. Each row wears its environment's badge and activity
 * glyph, and an environment's heading is followed by its notes: its state
 * ("unreachable since"), a list that failed, "no sessions".
 */

export interface RailHeading {
  readonly kind: "heading";
  /** The heading's name as `collapsedHeadings` keys it: `block:pinned`, `group:<name key>`, `environment:<id>`, `shelf:snoozed`, `shelf:settled`, `shelf:archive`. */
  readonly key: string;
  readonly heading: HeadingKind;
  readonly text: string;
  /** The sessions under it, before any filter. */
  readonly count: number;
  /** Null for an environment's heading, whose Enter starts a session rather than folding it. */
  readonly folded: boolean | null;
  /** A command about one of its groups awaits its receipt (the runtime's `awaitingReceipt`), or, while it is folded, one about a session under it. */
  readonly pending: boolean;
  /** Its environment cannot be reached (an environment's heading). */
  readonly dim: boolean;
  readonly environmentId: string | null;
  /** How many commands wait in the outbox for the environment (an environment's heading). */
  readonly pendingCommands: number;
}

export interface RailRow extends HeadingRow {
  readonly kind: "row";
  readonly badge: Badge;
  readonly glyph: Glyph;
  readonly tags: readonly string[];
}

/** A line nothing is done on: an environment's state, "no sessions", a list that failed. */
export interface RailNote {
  readonly kind: "note";
  readonly key: string;
  readonly text: string;
}

export type RailLine = RailHeading | RailRow | RailNote;

export interface RailInput extends HeadingsInput {
  /** Each environment's badge (`badgesOf` over `environments`). */
  readonly badges: ReadonlyMap<string, Badge>;
  /** The local environment's service is being started from here. */
  readonly startingService: boolean;
}


/** A heading's line, and the notes an environment's is followed by while there is no filter. */
const headingLines = (heading: SessionHeading, input: RailInput): RailLine[] => {
  const count = heading.block.rows.length;
  if (heading.kind !== "environment") {
    return [{ kind: "heading", key: heading.key, heading: heading.kind, text: heading.text, count, folded: heading.folded, pending: heading.pending, dim: false, environmentId: null, pendingCommands: 0 }];
  }
  const view: EnvironmentView = heading.environment;
  const line: RailHeading = {
    kind: "heading",
    key: heading.key,
    heading: "environment",
    text: nameOf(view),
    count,
    folded: null,
    pending: view.pendingCommands > 0,
    dim: heading.dim,
    environmentId: view.environmentId,
    pendingCommands: view.pendingCommands,
  };
  if (input.matches !== null) return [line];
  const notes: RailNote[] = [];
  const state = headingState(view, input.startingService);
  if (state !== undefined) notes.push({ kind: "note", key: `${view.environmentId}:state`, text: state });
  const fault = heading.list?.fault ?? null;
  if (fault !== null) notes.push({ kind: "note", key: `${view.environmentId}:fault`, text: `the list failed: ${fault}` });
  if (heading.empty) notes.push({ kind: "note", key: `${view.environmentId}:empty`, text: "no sessions" });
  return [line, ...notes];
};

export const railLines = (input: RailInput): RailLine[] =>
  sessionHeadings(input).flatMap((heading) => [
    ...headingLines(heading, input),
    ...heading.rows.map(
      (row): RailRow => ({
        kind: "row",
        ...row,
        badge: input.badges.get(row.row.environmentId) ?? UNLISTED_BADGE,
        glyph: glyphOf(row.row.summary),
        tags: row.row.summary.tags,
      }),
    ),
  ]);

/** The heading the line `key` names is under, whatever the folds; undefined for a line not listed, or not under a heading. */
export const headingOver = (input: RailInput, key: string): RailHeading | undefined => {
  const all = railLines({ ...input, matches: null, open: true });
  const at = all.findIndex((line) => line.key === key);
  return at === -1 ? undefined : all.slice(0, at).reverse().find((line): line is RailHeading => line.kind === "heading");
};

/** The lines the cursor stops on: headings and rows. */
export const isSelectable = (line: RailLine): line is RailHeading | RailRow => line.kind !== "note";

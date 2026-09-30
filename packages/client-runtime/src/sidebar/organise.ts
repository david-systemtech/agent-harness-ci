import { groupNameKey, type SessionSummary } from "@agent-harness/contracts";
import type { Commands, DispatchAnswer } from "../outbox/outbox.js";
import type { MergedGroupHeading, SessionRow } from "../projections/session-list.js";

/**
 * The organising rules a session's commands follow (docs/specs/tui.md, "The
 * rail"; docs/specs/gui.md, "The window and the sidebar"), which the
 * terminal UI's rail keys and pickers and the window's context menu both
 * send by, so both offer and send the same: which of a toggle's two
 * commands a session takes, when its snooze stands (Wake now is offered),
 * whether it holds a tag (adding it again changes nothing, so it is offered
 * to be taken off), which groups it can be moved into, and a merged
 * heading's rename and delete, one command per member group (#128).
 */

/** A session state that one command turns on and another off. */
export type Toggle = "archive" | "pin" | "settle";

/** The command a toggle sends, and whether the state is on now (the command turns it off). */
export type Toggled =
  | { readonly method: "sessions.archive" | "sessions.unarchive"; readonly on: boolean }
  | { readonly method: "sessions.pin" | "sessions.unpin"; readonly on: boolean }
  | { readonly method: "sessions.settle" | "sessions.unsettle"; readonly on: boolean };

/** The command a toggle sends as the session stands. */
export const toggleOf = (summary: Pick<SessionSummary, "archivedAt" | "pinnedAt" | "settledAt">, toggle: Toggle): Toggled => {
  switch (toggle) {
    case "archive":
      return summary.archivedAt === null ? { method: "sessions.archive", on: false } : { method: "sessions.unarchive", on: true };
    case "pin":
      return summary.pinnedAt === null ? { method: "sessions.pin", on: false } : { method: "sessions.unpin", on: true };
    case "settle":
      return summary.settledAt === null ? { method: "sessions.settle", on: false } : { method: "sessions.unsettle", on: true };
  }
};

/** The session's snooze stands: its wake time is after its environment's `now`. A past one is awake, whether or not the sweep has woken it. */
export const snoozeStands = (summary: Pick<SessionSummary, "snoozedUntil">, now: Date): boolean =>
  summary.snoozedUntil !== null && Date.parse(summary.snoozedUntil) > now.getTime();

/** The session holds `tag`, ignoring case and the white space around it, as the environment compares tags. */
export const hasTag = (summary: Pick<SessionSummary, "tags">, tag: string): boolean => {
  const wanted = tag.trim().toLowerCase();
  return summary.tags.some((held) => held.toLowerCase() === wanted);
};

/** The groups a session can be moved into, for what is typed. */
export interface GroupChoices {
  /** The merged headings whose names hold what is typed, in the list's order; `here` the one the session is in. */
  readonly listed: readonly { readonly heading: MergedGroupHeading; readonly here: boolean }[];
  /** What is typed, white space collapsed, when no heading has that name (ignoring case and white space): a new group. */
  readonly fresh: string | null;
  /** The session is in a group, so it can be taken out of it. */
  readonly out: boolean;
}

/** Every merged heading (the session list's `groups`) matching `typed`, the new one typed, and no group: `commands.moveToGroup`'s choices. */
export const groupChoices = (groups: readonly MergedGroupHeading[], row: SessionRow, typed: string): GroupChoices => {
  const name = typed.trim().replace(/\s+/g, " ");
  const needle = name.toLowerCase();
  return {
    listed: groups
      .filter((heading) => heading.name.toLowerCase().includes(needle))
      .map((heading) => ({ heading, here: heading.groups.some((member) => member.environmentId === row.environmentId && member.groupId === row.summary.groupId) })),
    fresh: name === "" || groups.some((heading) => heading.key === groupNameKey(name)) ? null : name,
    out: row.summary.groupId !== null,
  };
};

/** A merged heading renamed, or deleted. */
export type HeadingChange = { readonly rename: string } | { readonly delete: true };

/**
 * Renames or deletes a merged heading: one `groups.rename` or `groups.delete`
 * per member group, each on its own environment, through the outbox.
 * Answers every command's answer, in the members' order.
 */
export const changeHeading = (
  commands: Pick<Commands, "dispatch">,
  heading: Pick<MergedGroupHeading, "groups">,
  change: HeadingChange,
): Promise<readonly DispatchAnswer<"groups.rename" | "groups.delete">[]> =>
  Promise.all(
    heading.groups.map((member): Promise<DispatchAnswer<"groups.rename" | "groups.delete">> =>
      "rename" in change
        ? commands.dispatch(member.environmentId, "groups.rename", { groupId: member.groupId, name: change.rename })
        : commands.dispatch(member.environmentId, "groups.delete", { groupId: member.groupId }),
    ),
  );

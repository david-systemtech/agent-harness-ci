import { groupChoices, presetTimes, rowKey, snoozeStands, toggleOf, whenWords, type HeadingRow } from "@agent-harness/client-runtime";
import type { CommandMethodName } from "@agent-harness/contracts";
import { useMemo } from "react";
import { usePaneGrid } from "../grid/grid.js";
import { useOpenInPane } from "../session/pane-line.js";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { Entry, SubEntry, useHandOn } from "./menu-entry.js";
import { useOrganise } from "./organise.js";
import { quoted } from "./words.js";

/**
 * A row's context menu (docs/specs/gui.md, "The window and the sidebar";
 * #398): every organisation command the terminal UI's rail keys send.
 * Rename (in place, `sessions.rename`); Pin or Unpin, Archive or Unarchive,
 * Settle or Unsettle, as the session stands (the runtime's `toggleOf`);
 * Snooze, the terminal UI's presets on this client's calendar from the
 * environment's now, each sent as UTC, or a date and time, and Wake now while
 * a snooze stands; Tags, one at a time; Move to group, the merged headings
 * (the one it is in dim), a new group, or none (`commands.moveToGroup`, the
 * runtime's `groupChoices`); Fork, at the session's end, the fork opening in
 * the focused pane once the environment accepts it; Open in a new pane, which
 * splits the focused pane right and opens the session there (#407), dim with
 * the reason while the grid holds eight panes; and Delete, asked once.
 * Each is drawn as the connection answers for its command
 * (`commands.admits`; Fork as its verb, `verbs.fork`): one that cannot be
 * sent is dim, the capability's line under its name. An organisation command
 * waits in the outbox while the environment cannot be reached, so it is
 * not dim for that.
 */

export interface RowMenuProps {
  readonly line: HeadingRow;
  /** Turns the row's title into a field, to rename it in place. */
  rename(): void;
}

export const RowMenu = ({ line, rename }: RowMenuProps) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const openInPane = useOpenInPane();
  const grid = usePaneGrid();
  const { row } = line;
  const { environmentId, summary } = row;
  const sessionId = summary.id;
  const session = { environmentId, sessionId };
  const list = useObservable(runtime.projections.sessionList);
  const verbs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId])).verbs;
  const admits = (method: CommandMethodName) => runtime.commands.admits(environmentId, method);
  const now = runtime.environmentNow(environmentId);
  const key = rowKey(row);
  const { handOn, onCloseAutoFocus } = useHandOn();

  const toggle = (which: "pin" | "archive" | "settle", on: string, off: string) => {
    const { method, on: set } = toggleOf(summary, which);
    return (
      <Entry offer={admits(method)} onSelect={() => organise.send(environmentId, method, { sessionId })}>
        {set ? off : on}
      </Entry>
    );
  };

  const fork = () => {
    organise.say(undefined);
    void runtime.commands.fork(environmentId, sessionId).then(({ sessionId: forked, answer }) => {
      if (answer.ok) openInPane(environmentId, forked);
      else organise.say(`Not forked: ${answer.error.message}`);
    });
  };

  const snooze = (at: Date) => organise.send(environmentId, "sessions.snooze", { sessionId, until: at.toISOString() });
  const move = (name: string | null) => organise.move(environmentId, sessionId, name);
  const moving = admits("sessions.setGroup");
  const choices = groupChoices(list.groups, row, "");

  return (
    <ContextMenuContent aria-label={`Organise ${quoted(summary.title)}`} onCloseAutoFocus={onCloseAutoFocus}>
      <Entry offer={admits("sessions.rename")} onSelect={handOn(rename)}>
        Rename
      </Entry>
      {toggle("pin", "Pin", "Unpin")}
      {toggle("archive", "Archive", "Unarchive")}
      {toggle("settle", "Settle", "Unsettle")}
      <ContextMenuSeparator />
      <SubEntry offer={admits("sessions.snooze")} name="Snooze">
        {presetTimes(now).map((preset) => (
          <Entry
            key={preset.label}
            offer={preset.at === null ? { status: "absent", message: preset.absent ?? "Not now." } : { status: "present" }}
            {...(preset.at !== null && { detail: whenWords(preset.at) })}
            onSelect={() => preset.at !== null && snooze(preset.at)}
          >
            {preset.label}
          </Entry>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handOn(() => organise.open({ kind: "snooze", row: key }))}>A date and time…</ContextMenuItem>
      </SubEntry>
      {snoozeStands(summary, now) && (
        <Entry offer={admits("sessions.unsnooze")} onSelect={() => organise.send(environmentId, "sessions.unsnooze", { sessionId })}>
          Wake now
        </Entry>
      )}
      <Entry offer={admits("sessions.tag")} onSelect={handOn(() => organise.open({ kind: "tags", row: key }))}>
        Tags…
      </Entry>
      <SubEntry offer={moving} name="Move to group">
        {choices.listed.map(({ heading, here }) => (
          <Entry key={heading.key} offer={here ? { status: "absent", message: "It is in this group." } : { status: "present" }} onSelect={() => move(heading.name)}>
            {heading.name}
          </Entry>
        ))}
        {choices.listed.length > 0 && <ContextMenuSeparator />}
        <ContextMenuItem onSelect={handOn(() => organise.open({ kind: "new-group", row: key }))}>New group…</ContextMenuItem>
        {choices.out && <ContextMenuItem onSelect={() => move(null)}>No group</ContextMenuItem>}
      </SubEntry>
      <ContextMenuSeparator />
      <Entry offer={verbs.fork} onSelect={fork}>
        Fork
      </Entry>
      <Entry offer={grid.openingBeside(session)} onSelect={() => grid.openBeside(grid.focused.id, "right", session)}>
        Open in a new pane
      </Entry>
      <Entry offer={admits("sessions.delete")} onSelect={handOn(() => organise.open({ kind: "delete", row: key }))}>
        Delete…
      </Entry>
    </ContextMenuContent>
  );
};

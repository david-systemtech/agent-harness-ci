import { groupChoices, presetTimes, rowKey, snoozeStands, toggleOf, whenWords, type HeadingRow } from "@agent-harness/client-runtime";
import type { CommandMethodName } from "@agent-harness/contracts";
import { Archive, Calendar, Check, Clock, FileText, Folder, FolderPlus, GitFork, Pin, PinOff, SquareSplitHorizontal, Tags, Trash2, Undo2, Pencil } from "lucide-react";
import { useMemo } from "react";
import { usePaneGrid } from "../grid/grid.js";
import { useOpenInPane } from "../session/pane-line.js";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { ContextMenuContent, ContextMenuSeparator } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { Entry, SubEntry, menuLetter, useHandOn } from "./menu-entry.js";
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
  const { narrow } = usePhoneFrame();
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
      <Entry icon={which === "pin" ? (set ? PinOff : Pin) : which === "archive" ? Archive : Check} letter={which === "pin" ? "P" : which === "archive" ? "A" : "U"} offer={admits(method)} onSelect={() => organise.send(environmentId, method, { sessionId })}>
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
    <ContextMenuContent className={narrow ? "phone-frame-menu w-72" : "w-[192px]"} onKeyDown={menuLetter} aria-label={`Organise ${quoted(summary.title)}`} onCloseAutoFocus={onCloseAutoFocus}>
      <Entry icon={Pencil} letter="R" offer={admits("sessions.rename")} onSelect={handOn(rename)}>
        Rename
      </Entry>
      {toggle("pin", "Pin", "Unpin")}
      {toggle("archive", "Archive", "Unarchive")}
      {toggle("settle", "Settle", "Unsettle")}
      <ContextMenuSeparator />
      <SubEntry icon={Clock} offer={admits("sessions.snooze")} name="Snooze">
        {presetTimes(now).map((preset) => (
          <Entry
            icon={Clock}
            key={preset.label}
            offer={preset.at === null ? { status: "absent", message: preset.absent ?? "Not now." } : { status: "present" }}
            {...(preset.at !== null && { detail: whenWords(preset.at) })}
            onSelect={() => preset.at !== null && snooze(preset.at)}
          >
            {preset.label}
          </Entry>
        ))}
        <ContextMenuSeparator />
        <Entry icon={Calendar} offer={admits("sessions.snooze")} onSelect={handOn(() => organise.open({ kind: "snooze", row: key }))}>A date and time…</Entry>
      </SubEntry>
      {snoozeStands(summary, now) && (
        <Entry icon={Undo2} letter="W" offer={admits("sessions.unsnooze")} onSelect={() => organise.send(environmentId, "sessions.unsnooze", { sessionId })}>
          Wake now
        </Entry>
      )}
      <Entry icon={Tags} letter="T" offer={admits("sessions.tag")} onSelect={handOn(() => organise.open({ kind: "tags", row: key }))}>
        Tags…
      </Entry>
      <Entry icon={FileText} letter="I" offer={admits("sessions.setInstructions")} onSelect={handOn(() => organise.open({ kind: "instructions", row: key }))}>
        Session instructions…
      </Entry>
      <SubEntry icon={Folder} offer={moving} name="Move to group">
        {choices.listed.map(({ heading, here }) => (
          <Entry icon={Folder} key={heading.key} offer={here ? { status: "absent", message: "It is in this group." } : { status: "present" }} onSelect={() => move(heading.name)}>
            {heading.name}
          </Entry>
        ))}
        {choices.listed.length > 0 && <ContextMenuSeparator />}
        <Entry icon={FolderPlus} offer={moving} onSelect={handOn(() => organise.open({ kind: "new-group", row: key }))}>New group…</Entry>
        {choices.out && <Entry icon={Folder} offer={moving} onSelect={() => move(null)}>No group</Entry>}
      </SubEntry>
      <ContextMenuSeparator />
      <Entry icon={GitFork} letter="F" offer={verbs.fork} onSelect={fork}>
        Fork
      </Entry>
      <Entry icon={SquareSplitHorizontal} letter="O" offer={grid.openingBeside(session)} onSelect={() => grid.openBeside(grid.focused.id, "right", session)}>
        Open in a new pane
      </Entry>
      <Entry icon={Trash2} letter="D" offer={admits("sessions.delete")} onSelect={handOn(() => organise.open({ kind: "delete", row: key }))}>
        Delete…
      </Entry>
    </ContextMenuContent>
  );
};

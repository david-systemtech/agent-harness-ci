import { ACTION_CONDITIONS, ACTION_GROUPS, isCommandId, isGuiOnly, settingsRow, type ActionCondition, type ListedAction } from "@agent-harness/contracts";
import { useId, useState, type KeyboardEvent } from "react";
import { chordOfEvent, keyLabel } from "../keys/chords.js";
import { useMacOS } from "../keys/key-dispatch.js";
import { clashOf, defaultGuiKeys, guiKeysOf, isRemappable, isWrittenOff, keyRefusal, withKey, withoutRemap, type KeyRemaps } from "../keys/key-map.js";
import { Button, Input, Switch } from "../ui/index.js";
import { usePresentation } from "../window-context.js";

/**
 * The Keyboard shortcuts pane, `appearance.shortcuts` (docs/specs/gui.md,
 * "Keyboard: the GUI column and the Keyboard shortcuts pane"; ADR 0022;
 * story 18; #418), a `client` row. "Esc stops the run" heads it, off by
 * default. Then every action of the shared list in its groups, found by
 * every word typed in its description, id or keys: its description, the
 * terminal UI's column (its defaults, read-only; the terminal UI remaps them
 * in its own keybindings file, which this pane never writes) and the GUI's
 * (the keys in force, a remapped row marked with its defaults, an absent row
 * dim with its reason). A GUI key is recorded by pressing it: the rules
 * refuse a reserved key or a stop on Ctrl+C, and a clash within the GUI
 * column is named, before anything is saved; Esc leaves a recording. Reset
 * returns a row, or every row, to its defaults. Remaps are presentation
 * (`keyRemaps`), which the window's keys follow at once.
 */
export const ShortcutsPane = () => {
  const macOS = useMacOS();
  const [remaps, setRemaps] = usePresentation("keyRemaps");
  const [escStopsRun] = usePresentation("escStopsRun");
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<Recording | undefined>(undefined);
  const [said, setSaid] = useState<{ readonly id: string; readonly line: string } | undefined>(undefined);

  const record = (action: ListedAction, place: number, key: string) => {
    setRecording(undefined);
    const refused = keyRefusal(action.id, key);
    if (refused !== undefined) return setSaid({ id: action.id, line: `Not saved: ${refused}` });
    const next = withKey(remaps, action, place, key);
    const other = clashOf(next, action.id, key, macOS);
    if (other !== undefined) return setSaid({ id: action.id, line: `Not saved: ${keyLabel(key, macOS)} is already “${other.description}” (${other.id}).` });
    setRemaps(next);
  };
  const keys: RowKeys = {
    macOS,
    remaps,
    escStopsRun,
    recording,
    start: (action, place) => {
      setSaid(undefined);
      setRecording({ id: action.id, place });
    },
    leave: () => setRecording(undefined),
    record,
    reset: (action) => setRemaps(withoutRemap(remaps, action.id)),
  };
  const found = ACTION_GROUPS.map((part) => ({
    title: part.title,
    actions: (part.actions as readonly ListedAction[]).filter((action) => matches(action, remaps, macOS, query)),
  })).filter((part) => part.actions.length > 0);

  return (
    <>
      <EscStopsRun />
      <p className="text-sm text-ink-muted">{settingsRow("appearance.shortcuts").hint}</p>
      <p className="text-sm text-ink-muted">
        The terminal UI&apos;s column is its defaults, read-only here: the terminal UI remaps its keys in keybindings.json in its state directory, or the file its
        --keybindings names, which this pane never writes.
      </p>
      <div className="flex items-center gap-2">
        <Input type="search" aria-label="Search the shortcuts" placeholder="Search the shortcuts" value={query} onChange={(event) => setQuery(event.target.value)} className="flex-1" />
        <Button disabled={Object.keys(remaps).length === 0} onClick={() => setRemaps({})}>
          Reset every key
        </Button>
      </div>
      {found.length === 0 ? (
        <p className="text-sm text-ink-faint">No action matches “{query}”.</p>
      ) : (
        found.map((part) => (
          <table key={part.title} aria-label={part.title} className="w-full border-collapse text-left text-sm">
            <caption className="py-1 text-left text-xs font-semibold text-ink-muted">{part.title}</caption>
            <thead>
              <tr className="border-b border-hairline text-xs text-ink-faint">
                <th scope="col" className="w-2/5 py-1 font-normal">
                  Action
                </th>
                <th scope="col" className="py-1 font-normal">
                  Terminal UI
                </th>
                <th scope="col" className="py-1 font-normal">
                  GUI
                </th>
              </tr>
            </thead>
            <tbody>
              {part.actions.map((action) => (
                <ActionRow key={action.id} action={action} keys={keys} line={said?.id === action.id ? said.line : undefined} />
              ))}
            </tbody>
          </table>
        ))
      )}
    </>
  );
};

/** The switch that heads the pane (ADR 0022): off, no key stops a run. */
const EscStopsRun = () => {
  const [on, set] = usePresentation("escStopsRun");
  const label = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line p-3">
      <div className="flex flex-col gap-0.5">
        <span id={label} className="text-sm text-ink">
          Esc stops the run
        </span>
        <span className="text-xs text-ink-muted">
          Off, no key stops a run: the Stop button and the palette&apos;s Stop the run do. On, Esc stops the focused pane&apos;s run once nothing else it closes is open.
        </span>
      </div>
      <Switch aria-labelledby={label} checked={on} onCheckedChange={set} />
    </div>
  );
};

/** A key being recorded: the action's, at its place in the column. */
interface Recording {
  readonly id: string;
  readonly place: number;
}

/** What each row draws its GUI keys from, and what it does with them. */
interface RowKeys {
  readonly macOS: boolean;
  readonly remaps: KeyRemaps;
  readonly escStopsRun: boolean;
  readonly recording: Recording | undefined;
  start(action: ListedAction, place: number): void;
  leave(): void;
  record(action: ListedAction, place: number, key: string): void;
  reset(action: ListedAction): void;
}

/** A condition's words after the keys it holds them under: ` (empty composer)`. */
const conditionWords = (when: ActionCondition | undefined): string => (when === undefined ? "" : ` (${ACTION_CONDITIONS[when].words})`);

/** A slash command as typed: its name. */
const typedName = (action: ListedAction): string => `/${action.id.slice("command.".length)}`;

/** Whether every word of `query` is in the action's description, id or keys (the terminal's, and the GUI's as written and as read here), ignoring case. */
const matches = (action: ListedAction, remaps: KeyRemaps, macOS: boolean, query: string): boolean => {
  const gui = guiKeysOf(action, remaps);
  const text = [action.description, action.id, ...action.keys, ...gui, ...gui.map((key) => keyLabel(key, macOS))].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
};

/** The terminal UI's column: its defaults, read-only, with the reason where it answers the action absent. */
const TerminalKeys = ({ action }: { readonly action: ListedAction }) => {
  if (isGuiOnly(action)) return <span className="text-ink-faint">None: only the GUI answers it.</span>;
  const keys = isCommandId(action.id) ? typedName(action) : `${action.keys.join(", ")}${conditionWords(action.when)}`;
  return action.status === "absent" ? <span className="text-ink-faint">{`${keys}: ${action.reason}`}</span> : <span className="font-mono text-ink">{keys}</span>;
};

/** One action: its description and id, the terminal UI's keys, and the GUI's. */
const ActionRow = ({ action, keys, line }: { readonly action: ListedAction; readonly keys: RowKeys; readonly line: string | undefined }) => {
  const absent = action.gui.status === "absent";
  return (
    <tr aria-label={action.description} aria-disabled={absent ? true : undefined} className="border-b border-hairline align-top aria-disabled:text-ink-faint">
      <td className="py-1.5 pr-3">
        <span className="block">{action.description}</span>
        <span className="block font-mono text-xs text-ink-faint">{action.id}</span>
      </td>
      <td className="py-1.5 pr-3">
        <TerminalKeys action={action} />
      </td>
      <td className="py-1.5">
        <GuiKeys action={action} keys={keys} />
        {line !== undefined && <p className="text-xs text-signal">{line}</p>}
      </td>
    </tr>
  );
};

/** The GUI's column: its reason where absent, a slash command as typed, else each key in force to record again, marked when remapped. */
const GuiKeys = ({ action, keys }: { readonly action: ListedAction; readonly keys: RowKeys }) => {
  if (action.gui.status === "absent") return <span>{action.gui.reason}</span>;
  if (!isRemappable(action)) return <span className="font-mono">{typedName(action)}</span>;
  const held = guiKeysOf(action, keys.remaps);
  const defaults = defaultGuiKeys(action);
  const remapped = keys.remaps[action.id] !== undefined;
  // A row with no key offers one place to record the first.
  const places = held.length === 0 ? [undefined] : held;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {places.map((key, place) => (
        <KeySlot key={place} action={action} place={place} written={key} keys={keys} />
      ))}
      {conditionWords(action.gui.when)}
      {isWrittenOff(action) && !keys.escStopsRun && <span className="text-xs text-ink-faint">Off: “Esc stops the run” turns it on.</span>}
      {remapped && (
        <>
          <span className="text-xs text-amber">Remapped from {defaults.length === 0 ? "no key" : defaults.map((key) => keyLabel(key, keys.macOS)).join(", ")}</span>
          <Button className="h-6 px-2 text-xs" onClick={() => keys.reset(action)}>
            Reset
          </Button>
        </>
      )}
    </div>
  );
};

/**
 * One GUI key of an action, or the place for its first: a press starts a
 * recording there, and the next key pressed on it (a lone modifier waits
 * for the key it goes with) is recorded, never reaching the window; Esc, or
 * the focus leaving, leaves the recording.
 */
const KeySlot = ({ action, place, written, keys }: { readonly action: ListedAction; readonly place: number; readonly written: string | undefined; readonly keys: RowKeys }) => {
  const recording = keys.recording?.id === action.id && keys.recording.place === place;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    const chord = chordOfEvent(event.nativeEvent, keys.macOS);
    if (chord === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (chord === "Esc") keys.leave();
    else keys.record(action, place, chord);
  };
  return (
    <Button
      data-recording={recording || undefined}
      className="h-6 border border-line px-2 font-mono text-xs data-recording:border-beam"
      onClick={() => !recording && keys.start(action, place)}
      onKeyDown={onKeyDown}
      onBlur={() => recording && keys.leave()}
    >
      {recording ? "Press a key…" : written === undefined ? "Record a key" : keyLabel(written, keys.macOS)}
    </Button>
  );
};

import { Box, Text } from "ink";
import { useEffect, useRef } from "react";
import type { Observable } from "@agent-harness/client-runtime";
import type { Badge } from "./badge.js";

/**
 * A list to choose from (the `picker` context of the shared action list):
 * the snooze, group, tag, search and restore pickers and the steps of
 * starting a session. A picker is data the screen holds as its open card:
 * its rows are computed from its query each time it is drawn, from the
 * runtime's projections, so it holds nothing of the environment's. A typed
 * picker takes every printable key into its query (`picker.filter`, the
 * table's `Letters`) before any letter-keyed action, so `k` and `j` move
 * only a list that is not typed at, as their row says. Choosing a row runs
 * it: it answers the next picker (a step on), nothing, and the picker
 * closes, or `STAYS`, and the picker stays open until what it waits on
 * closes it. A picker keeps its `rows` through typing and moving, so they
 * name it. Esc clears the query, then goes back a step, then closes.
 */

export interface PickerRow {
  readonly key: string;
  readonly text: string;
  /** Dim words after the text: a time, a path's detail, a count. */
  readonly detail?: string;
  readonly badge?: Badge;
  /** Why it cannot be chosen now: drawn dim, and said when chosen. */
  readonly absent?: string;
  /** What `picker.hide` does on it: a known directory taken off the list on this client. None, and the key says it hides nothing here. */
  readonly hide?: () => void;
  /**
   * What choosing it does: the next picker, nothing when it is done, or
   * `STAYS` when the picker stays as it is, waiting on an answer its own
   * note follows (a session the environment is asked to make).
   */
  readonly choose?: () => Picker | typeof STAYS | void;
}

/** A choice that keeps its picker open as it is: query, cursor and all. */
export const STAYS = "stays";

/** A chip over a step: environment, account, model, then workspace, in that order (ADR 0005). */
export interface Chip {
  readonly label: string;
  readonly value: string;
  readonly colour?: string;
}

export interface Picker {
  /** The title, or what reads it as drawn (a browse step's, which names the directory once it is listed). */
  readonly title: string | (() => string);
  /** The chips over the rows, or what reads them as drawn (presets that arrive while the card is up). */
  readonly chips?: readonly Chip[] | (() => readonly Chip[]);
  /** Printable keys go into the query. */
  readonly typed: boolean;
  /** What to type, while the query is empty. */
  readonly placeholder?: string;
  readonly query: string;
  readonly cursor: number;
  readonly rows: (query: string) => readonly PickerRow[];
  /** What the rows read that may change while the picker is open: followed while it is drawn (following a cached query fetches it). */
  readonly follows?: readonly Observable<unknown>[];
  /** Where Esc goes on an empty query; the picker closes when there is none. */
  readonly back?: Picker;
  /** A line under the rows: what is not listed, and why. */
  readonly note?: (query: string) => string | undefined;
}

export const pickerOf = (fields: Omit<Picker, "query" | "cursor"> & { readonly query?: string }): Picker => ({ query: "", cursor: 0, ...fields });

/** The row under the cursor, the cursor held inside the rows there are. */
export const rowAt = (picker: Picker): PickerRow | undefined => {
  const rows = picker.rows(picker.query);
  return rows[Math.min(Math.max(picker.cursor, 0), rows.length - 1)];
};

export const movedBy = (picker: Picker, step: number): Picker => {
  const count = picker.rows(picker.query).length;
  return { ...picker, cursor: count === 0 ? 0 : Math.min(Math.max(picker.cursor + step, 0), count - 1) };
};

/**
 * What a key typed at a list adds to its query: the text, control bytes
 * left out and line breaks as spaces; undefined for a key that is not text
 * (an arrow, Enter, Esc, Tab, Backspace, a Ctrl or Alt chord). Ink names the
 * arrows and hands them over with no input; a key it does not name (Home, a
 * function key) arrives as its escape sequence with no flag set, which is
 * never text either.
 */
export const printableText = (input: string, key: { readonly ctrl: boolean; readonly meta: boolean; readonly escape: boolean; readonly tab: boolean; readonly return: boolean; readonly backspace: boolean; readonly delete: boolean }): string | undefined => {
  if (input === "" || input.includes("\u001b") || key.ctrl || key.meta || key.escape || key.tab || key.return || key.backspace || key.delete) return undefined;
  const text = input.replace(/[\r\n]+/g, " ").replace(/\p{Cc}/gu, "");
  return text === "" ? undefined : text;
};

export const typedInto = (picker: Picker, text: string): Picker => ({ ...picker, query: picker.query + text, cursor: 0 });
export const erasedFrom = (picker: Picker): Picker => ({ ...picker, query: [...picker.query].slice(0, -1).join(""), cursor: 0 });

export const PickerCard = (props: { readonly picker: Picker; readonly hint: string; readonly height: number; readonly onChange: () => void }) => {
  const { picker } = props;
  // Follows what the rows read while the card is up, so a change (an answer arriving) is drawn.
  useEffect(() => {
    const stops = (picker.follows ?? []).map((source) => source.subscribe(props.onChange));
    return () => stops.forEach((stop) => stop());
  }, [picker.follows, props.onChange]);
  const rows = picker.rows(picker.query);
  const cursor = Math.min(Math.max(picker.cursor, 0), Math.max(rows.length - 1, 0));
  const note = picker.note?.(picker.query);
  const title = typeof picker.title === "function" ? picker.title() : picker.title;
  const chips = typeof picker.chips === "function" ? picker.chips() : picker.chips;
  const room = Math.max(1, props.height - 3 - (chips ? 1 : 0) - (note ? 1 : 0));
  // Scrolled as little as keeps the cursor in sight, from where it was (the rail's rule).
  const scrolled = useRef(0);
  let top = scrolled.current;
  if (cursor < top) top = cursor;
  if (cursor >= top + room) top = cursor - room + 1;
  top = Math.max(0, Math.min(top, rows.length - room));
  scrolled.current = top;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        {title} <Text dimColor>{props.hint}</Text>
      </Text>
      {chips && (
        <Text wrap="truncate-end">
          {chips.map((chip, i) => (
            <Text key={chip.label}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text dimColor>{chip.label} </Text>
              <Text {...(chip.colour !== undefined && { color: chip.colour })}>{chip.value}</Text>
            </Text>
          ))}
        </Text>
      )}
      {picker.typed && (
        <Text wrap="truncate-start">
          <Text color="cyan">› </Text>
          {picker.query === "" ? <Text dimColor>{picker.placeholder ?? "type to filter"}</Text> : picker.query}
        </Text>
      )}
      {/* With nothing typed there is nothing to match: the note says why the list is empty. */}
      {rows.length === 0 && (picker.query.trim() !== "" || note === undefined) && <Text dimColor>{"  "}{picker.query.trim() !== "" ? "nothing matches" : "nothing to choose from"}</Text>}
      {rows.slice(top, top + room).map((row, i) => {
        const selected = i + top === cursor;
        return (
          <Text key={row.key} wrap="truncate-end" inverse={selected} dimColor={row.absent !== undefined}>
            {selected ? "› " : "  "}
            {row.badge && (
              <Text color={row.badge.colour}>
                {row.badge.icon}
                {row.badge.abbreviation}{" "}
              </Text>
            )}
            {row.text}
            {row.detail !== undefined && <Text dimColor> {row.detail}</Text>}
            {row.absent !== undefined && <Text dimColor> ({row.absent})</Text>}
          </Text>
        );
      })}
      {note !== undefined && <Text dimColor wrap="truncate-end">{note}</Text>}
    </Box>
  );
};

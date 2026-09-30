import { Box, Text } from "ink";
import { useRef } from "react";
import type { RailHeading, RailLine, RailRow } from "./model.js";

/**
 * The rail as drawn: the lines `railLines` gives, scrolled to keep the
 * cursor in sight, beside the pane (its edge in colour while it has the
 * keys) or, under 100 columns, in the pane's place as the picker that
 * stands in for it. A row is its environment's badge, its activity glyph,
 * its title and tags, a snoozed session's wake time and the pending marker
 * (`↻`, one column, so a snoozed row waiting on a command keeps some of its
 * title at 28 columns; a heading says `pending` in words) while a command
 * about it waits; a down environment's rows are dim. The cursor is
 * drawn only while the rail has the keys: `›` on a row, a heading in
 * reverse.
 */

/** The rail's width beside the pane, its edge included: #143's, which leaves the pane the 72 columns its cards need at 100. */
export const RAIL_WIDTH = 28;

/** A row's pending marker: a command about it waits for its answer. */
const PENDING_MARK = "↻";

const HeadingLine = (props: { readonly line: RailHeading; readonly selected: boolean }) => {
  const { line, selected } = props;
  if (line.folded === null) {
    return (
      <Text wrap="truncate-end">
        <Text bold inverse={selected} dimColor={line.dim}>
          {line.text}
        </Text>
        {line.pendingCommands > 0 && <Text color="yellow"> {line.pendingCommands} pending</Text>}
      </Text>
    );
  }
  return (
    <Text wrap="truncate-end">
      <Text bold inverse={selected}>
        {line.folded ? "▸" : "▾"} {line.text}
      </Text>
      {line.folded && <Text dimColor> {line.count}</Text>}
      {line.pending && <Text color="yellow"> pending</Text>}
    </Text>
  );
};

const RowLine = (props: { readonly line: RailRow; readonly selected: boolean }) => {
  const { line, selected } = props;
  const { badge, glyph, dim } = line;
  return (
    <Box height={1} flexDirection="row">
      <Box flexShrink={0}>
        <Text>
          {selected ? <Text color="cyan">›</Text> : " "}{" "}
          <Text color={badge.colour} dimColor={dim}>
            {badge.abbreviation}
          </Text>{" "}
          <Text {...(glyph.colour !== undefined && !dim && { color: glyph.colour })} dimColor={dim || glyph.dim}>
            {glyph.text}
          </Text>{" "}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end" dimColor={dim} bold={selected}>
          {line.row.summary.title}
          {line.tags.length > 0 && <Text dimColor> {line.tags.map((tag) => `#${tag}`).join(" ")}</Text>}
        </Text>
      </Box>
      {line.wake !== null && (
        <Box flexShrink={0}>
          <Text dimColor> {line.wake}</Text>
        </Box>
      )}
      {line.pending && (
        <Box flexShrink={0}>
          <Text color="yellow"> {PENDING_MARK}</Text>
        </Box>
      )}
    </Box>
  );
};

export interface RailViewProps {
  readonly lines: readonly RailLine[];
  /** The key of the line under the cursor. */
  readonly cursor: string | null;
  readonly focused: boolean;
  /** What is typed after `/`; null while not filtering. */
  readonly filter: string | null;
  /** Rows there are to draw in. */
  readonly height: number;
  /** Beside the pane; undefined, in its place. */
  readonly width?: number;
  /** A title over the rail in the pane's place, with the hint beside it. */
  readonly title?: { readonly text: string; readonly hint: string };
}

export const RailView = (props: RailViewProps) => {
  const { lines, focused } = props;
  const room = Math.max(1, props.height - (props.filter !== null ? 1 : 0) - (props.title ? 1 : 0));
  const at = lines.findIndex((line) => line.key === props.cursor);
  // Scrolled as little as keeps the cursor in sight, from where it was.
  const top = useRef(0);
  let from = top.current;
  if (at !== -1 && at < from) from = at;
  if (at !== -1 && at >= from + room) from = at - room + 1;
  from = Math.max(0, Math.min(from, Math.max(0, lines.length - room)));
  top.current = from;
  const edge = props.width === undefined ? {} : { width: props.width, borderStyle: "single" as const, borderTop: false, borderBottom: false, borderLeft: false };
  return (
    <Box flexDirection="column" flexShrink={0} flexGrow={props.width === undefined ? 1 : 0} {...edge} {...(focused && props.width !== undefined && { borderColor: "cyan" })}>
      {props.title && (
        <Text bold wrap="truncate-end">
          {props.title.text} <Text dimColor>{props.title.hint}</Text>
        </Text>
      )}
      {props.filter !== null && (
        <Text wrap="truncate-start">
          <Text color="cyan">/</Text>
          {props.filter}
          {focused && <Text inverse> </Text>}
        </Text>
      )}
      {props.filter !== null && lines.length === 0 && <Text dimColor>{"  "}nothing matches</Text>}
      {lines.slice(from, from + room).map((line) => {
        const selected = focused && line.key === props.cursor;
        if (line.kind === "heading") return <HeadingLine key={line.key} line={line} selected={selected} />;
        if (line.kind === "row") return <RowLine key={line.key} line={line} selected={selected} />;
        return (
          <Text key={line.key} dimColor wrap="truncate-end">
            {"  "}
            {line.text}
          </Text>
        );
      })}
    </Box>
  );
};

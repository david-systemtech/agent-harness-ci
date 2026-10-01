import { Box, Text, useBoxMetrics, type DOMElement } from "ink";
import { useContext, useEffect, useRef } from "react";
import { oneLine, type QueuedMessage, type VerbAvailability } from "@agent-harness/client-runtime";
import type { DelegatedWorkRow } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { ThemeColoursContext, type DiffBand } from "../theme/colours.js";
import { terminalChip, type Line, type Span } from "../transcript/lines.js";

/**
 * The transcript on screen (docs/specs/tui.md, "The screen" and "The
 * transcript"): bottom-anchored, drawn from the lines `lines.ts` makes of
 * `projections.session`, scrolled back by a count of lines from the end,
 * with the freshness marker heading it until the stream is `live`; under it
 * the delegated-work strip, the queued line and the rewound strip. Every
 * component draws its props: the lines, the offset and the cursor are the
 * app's.
 */

/**
 * One styled line, cut rather than wrapped (`lines.ts` has wrapped it to the width already); a diff's addition or
 * removal across the width on its band, where the theme gives one.
 */
export const StyledLine = (props: {
  readonly spans: readonly Span[];
  readonly band?: DiffBand | undefined;
  readonly gutter?: string | undefined;
  readonly gutterColor?: string;
}) => {
  const colours = useContext(ThemeColoursContext);
  const background = props.band === undefined ? undefined : colours.band(props.band);
  return (
    <Box flexShrink={0} {...(background !== undefined && { backgroundColor: background })}>
      <Text wrap="truncate-end">
        {props.gutter !== undefined && <Text {...(props.gutterColor !== undefined && { color: props.gutterColor })}>{props.gutter}</Text>}
        {props.spans.length === 0 ? " " : props.spans.map((span, index) => (
          <Text
            key={index}
            {...(span.color !== undefined && { color: span.color })}
            {...(span.background !== undefined && { backgroundColor: span.background })}
            dimColor={span.dim ?? false}
            bold={span.bold ?? false}
            italic={span.italic ?? false}
            underline={span.underline ?? false}
            inverse={span.inverse ?? false}
            strikethrough={span.strikethrough ?? false}
          >
            {span.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
};

/** The lines to draw in a viewport `height` lines tall, scrolled `offset` lines back from the end. */
export const visibleLines = (lines: readonly Line[], height: number, offset: number): readonly Line[] => {
  const end = Math.max(0, lines.length - offset);
  return lines.slice(Math.max(0, end - height), end);
};

/** How far back the viewport may scroll: the lines above its first screen. */
export const maxOffset = (lines: readonly Line[], height: number): number => Math.max(0, lines.length - height);

/**
 * The offset that shows `row` whole, or as much of it from its top as fits,
 * moving as little as it can from `offset`: what keeps the transcript's
 * cursor in view.
 */
export const offsetShowing = (lines: readonly Line[], row: string, offset: number, height: number): number => {
  const first = lines.findIndex((line) => line.row === row);
  if (first === -1) return offset;
  let last = first;
  while (lines[last + 1]?.row === row) last++;
  const end = lines.length - offset;
  const top = end - height;
  if (first < top) return Math.min(maxOffset(lines, height), lines.length - (first + height));
  if (last >= end) return Math.max(0, lines.length - (last + 1));
  return offset;
};

export interface TranscriptViewProps {
  readonly lines: readonly Line[];
  /** Lines scrolled back from the end; zero follows it. */
  readonly offset: number;
  /** The row under the cursor while the transcript has the keys; undefined when it has not (no gutter is drawn). */
  readonly cursor: string | null | undefined;
  /** The freshness marker, when the stream is not live yet. */
  readonly marker: { readonly text: string; readonly color: string } | undefined;
  /** What to say with no line to draw. */
  readonly empty: string;
  /** The rows the viewport has for lines, as laid out (the marker's row not counted): the app's to scroll by and to keep the cursor in view with. */
  readonly onHeight: (height: number) => void;
  /** Said on the last line while scrolled back: how to follow the end again. */
  readonly follow: string;
}

/**
 * The viewport: as many of the last lines as its box has rows, measured
 * after each layout (the box is what is left of the screen, so its height
 * moves as the composer grows or a card opens).
 */
export const TranscriptView = (props: TranscriptViewProps) => {
  const box = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(box);
  const { onHeight } = props;
  // The rows the lines have: the box less the marker's row, which is what the app scrolls by.
  const height = Math.max(0, metrics.height - (props.marker ? 1 : 0));
  useEffect(() => {
    if (metrics.hasMeasured) onHeight(height);
  }, [metrics.hasMeasured, height, onHeight]);
  const scrolled = props.offset > 0;
  const shown = visibleLines(props.lines, Math.max(0, height - (scrolled ? 1 : 0)), props.offset);
  const firstOf = new Set<number>();
  shown.forEach((line, index) => {
    if (index === 0 || shown[index - 1]?.row !== line.row) firstOf.add(index);
  });
  return (
    <Box ref={box} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      {props.marker && (
        <Box flexShrink={0}>
          <Text color={props.marker.color} wrap="truncate-end">
            {props.marker.text}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
        {props.lines.length === 0 && <Text dimColor> {props.empty}</Text>}
        {shown.map((line, index) => {
          const onCursor = props.cursor !== undefined && props.cursor === line.row;
          return (
            <StyledLine
              key={index}
              spans={line.spans}
              gutter={props.cursor === undefined ? undefined : onCursor && firstOf.has(index) ? "❯" : " "}
              gutterColor={TERMINAL_ROLES.machine}
            />
          );
        })}
        {scrolled && (
          <Box flexShrink={0}>
            <Text color={TERMINAL_ROLES.warning} wrap="truncate-end">
              ↓ {props.offset} more line{props.offset === 1 ? "" : "s"} · {props.follow}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

/** Delegated work still going in the live run: one line per task, the strip under the transcript. */
export const DelegatedStrip = (props: { readonly tasks: readonly DelegatedWorkRow[]; readonly cursor?: string | undefined }) => (
  <Box flexDirection="column" flexShrink={0}>
    {props.tasks.map((task) => (
      <Text key={task.taskId} wrap="truncate-end" dimColor={props.cursor !== task.taskId}>
        <Text color={TERMINAL_ROLES.accent}>{props.cursor === task.taskId ? "› " : "  "}</Text>
        <Text color={TERMINAL_ROLES.machine}>⤷ </Text>
        {task.subagentType ?? task.kind}: {oneLine(task.description, 120)} <Text dimColor>· {task.status}</Text>
      </Text>
    ))}
  </Box>
);

/** A verb of the queued line: its keys in force, what it does, and whether it can be used now. */
export interface QueueVerb {
  readonly keys: string;
  readonly words: string;
  readonly availability: VerbAvailability;
}

/**
 * The queued line (ADR 0022; #231): the session's queue from
 * `projections.runs`, oldest first, each message with its attachments as
 * the transcript's chips and saying whether the provider is steering it into the turn or it
 * waits for the next run; under it the verbs on the queue, read now and
 * withdraw, in the keys in force: those that can be used now on one line,
 * and each that cannot on a line of its own, dim with its reason, never
 * hidden.
 */
export const QueuedLine = (props: { readonly queue: readonly QueuedMessage[]; readonly steers: boolean; readonly verbs: readonly QueueVerb[] }) => {
  if (props.queue.length === 0) return null;
  const present = props.verbs.filter((verb) => verb.availability.status === "present");
  const absent = props.verbs.flatMap((verb) => (verb.availability.status === "absent" ? [{ ...verb, reason: verb.availability.message }] : []));
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.queue.map((message) => {
        const steering = props.steers && message.heldBy === "provider";
        return (
          <Text key={message.messageId} wrap="truncate-end">
            <Text color={steering ? TERMINAL_ROLES.machine : TERMINAL_ROLES.warning}>{steering ? "  ↳ steering " : "  ⧗ queued "}</Text>
            <Text dimColor>{oneLine(message.text, 200)}</Text>
            {message.attachments.map((attachment, index) => (
              <Text key={index} dimColor>
                {" "}
                {terminalChip(attachment)}
              </Text>
            ))}
          </Text>
        );
      })}
      {present.length > 0 && (
        <Text>
          {"  "}
          {present.map((verb, index) => (
            <Text key={verb.words}>
              {index > 0 && <Text dimColor> · </Text>}
              <Text color={TERMINAL_ROLES.machine}>{verb.keys}</Text>
              <Text dimColor> {verb.words}</Text>
            </Text>
          ))}
        </Text>
      )}
      {absent.map((verb) => (
        <Text key={verb.words} dimColor>
          {"  "}
          {verb.keys} {verb.words} ({verb.reason})
        </Text>
      ))}
    </Box>
  );
};

/**
 * The rewound strip (ADR 0022; #232): after a rewind, until the next run
 * starts on the session, what it went back to and how to take it back, the
 * last line over the composer that now holds the rewound prompt; the undo
 * dim with the runtime's reason while it cannot be used now, never hidden.
 */
export const RewoundStrip = (props: { readonly text: string; readonly undo: string; readonly availability: VerbAvailability }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end">
      <Text color={TERMINAL_ROLES.warning}>{"  ↶ "}</Text>
      <Text>Rewound to {oneLine(props.text, 120)}</Text>
      <Text dimColor> · </Text>
      {props.availability.status === "present" ? (
        <Text color={TERMINAL_ROLES.machine}>{props.undo}</Text>
      ) : (
        <Text dimColor>
          {props.undo} ({props.availability.message})
        </Text>
      )}
    </Text>
  </Box>
);

/**
 * A card of lines scrolled from the top: the pager over the whole
 * transcript, `/timeline`, `/tasks`. `top` is the first line shown.
 */
export const LinesCard = (props: {
  readonly title: string;
  readonly hint: string;
  readonly lines: readonly Line[];
  readonly top: number;
  readonly height: number;
  readonly footer?: string | undefined;
}) => {
  const shown = props.lines.slice(props.top, props.top + props.height);
  const below = Math.max(0, props.lines.length - props.top - props.height);
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold wrap="truncate-end">
          {props.title} <Text dimColor>{props.hint}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {shown.map((line, index) => (
          <StyledLine key={index} spans={line.spans} band={line.band} />
        ))}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {props.footer ?? (below > 0 ? `${below} more line${below === 1 ? "" : "s"}` : "the end")}
        </Text>
      </Box>
    </Box>
  );
};

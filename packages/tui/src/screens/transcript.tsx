import { Box, Text, useBoxMetrics, type DOMElement } from "ink";
import { useEffect, useRef } from "react";
import type { UserMessageEntry } from "@agent-harness/client-runtime";
import type { DelegatedWorkRow } from "@agent-harness/contracts";
import { oneLine } from "../transcript/format.js";
import type { Line, Span } from "../transcript/lines.js";

/**
 * The transcript on screen (docs/specs/tui.md, "The screen" and "The
 * transcript"): bottom-anchored, drawn from the lines `lines.ts` makes of
 * `projections.session`, scrolled back by a count of lines from the end,
 * with the freshness marker heading it until the stream is `live`; under it
 * the delegated-work strip and the queued line. Every component draws its
 * props: the lines, the offset and the cursor are the app's.
 */

/** One styled line, cut rather than wrapped (`lines.ts` has wrapped it to the width already). */
export const StyledLine = (props: { readonly spans: readonly Span[]; readonly gutter?: string | undefined; readonly gutterColor?: string }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end">
      {props.gutter !== undefined && <Text {...(props.gutterColor !== undefined && { color: props.gutterColor })}>{props.gutter}</Text>}
      {props.spans.length === 0 ? " " : props.spans.map((span, index) => (
        <Text
          key={index}
          {...(span.color !== undefined && { color: span.color })}
          dimColor={span.dim ?? false}
          bold={span.bold ?? false}
          italic={span.italic ?? false}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  </Box>
);

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
              gutterColor="cyan"
            />
          );
        })}
        {scrolled && (
          <Box flexShrink={0}>
            <Text color="yellow" wrap="truncate-end">
              ↓ {props.offset} more line{props.offset === 1 ? "" : "s"} · {props.follow}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

/** Delegated work still going in the live run: one line per task, Artemis's strip, under the transcript. */
export const DelegatedStrip = (props: { readonly tasks: readonly DelegatedWorkRow[] }) => (
  <Box flexDirection="column" flexShrink={0}>
    {props.tasks.map((task) => (
      <Text key={task.taskId} wrap="truncate-end" dimColor>
        {"  "}
        <Text color="cyan">⤷ </Text>
        {task.subagentType ?? task.kind}: {oneLine(task.description, 120)} <Text dimColor>· {task.status}</Text>
      </Text>
    ))}
  </Box>
);

/**
 * The queued line (ADR 0022): the messages sent during the live run and not
 * yet read, oldest first, each saying whether the provider is steering it
 * into the turn or it waits for the next run.
 */
export const QueuedLine = (props: { readonly queued: readonly UserMessageEntry[]; readonly steers: boolean }) => (
  <Box flexDirection="column" flexShrink={0}>
    {props.queued.map((message) => {
      const steering = props.steers && message.heldBy === "provider";
      return (
        <Text key={message.messageId} wrap="truncate-end">
          <Text color={steering ? "cyan" : "yellow"}>{steering ? "  ↳ steering " : "  ⧗ queued "}</Text>
          <Text dimColor>{oneLine(message.text, 200)}</Text>
          {message.attachments.length > 0 && <Text dimColor> · {message.attachments.length} attached</Text>}
        </Text>
      );
    })}
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
          <StyledLine key={index} spans={line.spans} />
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

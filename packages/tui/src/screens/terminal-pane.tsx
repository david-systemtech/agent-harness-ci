import { Box, Text } from "ink";
import type { TerminalStatus } from "@agent-harness/client-runtime";
import type { Span } from "../transcript/lines.js";
import { StyledLine } from "./transcript.js";

/**
 * The terminal pane on screen (docs/specs/tui.md, "The terminal pane"):
 * between the transcript and the composer, a header naming what runs (the
 * session's shell, or a `!` command), the environment it runs on and how
 * its subscription stands, or how the command ended, then the emulator's
 * rows as styled lines, each exactly as wide as the terminal. The header is
 * in colour while the pane has the keys.
 */

/**
 * The frame's rows that are not the column the pane is drawn in: the header above it, and the six rows under it (the two
 * lines, the composer, the status line's two and the activity line, #147).
 */
export const OUTSIDE_COLUMN = 7;

/**
 * The rows the pane's terminal has: two fifths of the frame, between 3 and 16 (a chosen default), and never more than the
 * column holds under the pane's own header, so a short frame keeps the rows under it.
 */
export const paneRows = (frameRows: number): number =>
  Math.max(1, Math.min(16, Math.max(3, Math.floor(frameRows * 0.4)), frameRows - OUTSIDE_COLUMN - 1));

const STATE: Readonly<Record<TerminalStatus | "opening", string | undefined>> = {
  opening: "opening…",
  "catching-up": "catching up…",
  live: undefined,
  unreachable: "reconnecting…",
  ended: "ended",
};

export const TerminalPaneView = (props: {
  /** `!` and the command a `!` pane runs; null for the session's shell. */
  readonly command: string | null;
  readonly environment: string;
  readonly status: TerminalStatus | "opening";
  /** How the pane's command ended (`exit 2`), once it has. */
  readonly ended: string | null;
  readonly focused: boolean;
  readonly rows: readonly (readonly Span[])[];
  readonly height: number;
  readonly hint: string;
}) => {
  const state = props.ended ?? STATE[props.status];
  const hint = props.focused ? (props.ended !== null ? "any key closes it" : undefined) : props.hint;
  const shown = Array.from({ length: props.height }, (_, i) => props.rows[i] ?? []);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0}>
        <Text wrap="truncate-end" {...(props.focused ? { color: "cyan" } : { dimColor: true })}>
          {`── ${props.command === null ? "terminal" : `!${props.command}`} · `}
          {props.environment}
          {state !== undefined && ` · ${state}`}
          {hint !== undefined && ` · ${hint}`}
        </Text>
      </Box>
      {shown.map((spans, index) => (
        <StyledLine key={index} spans={spans} />
      ))}
    </Box>
  );
};

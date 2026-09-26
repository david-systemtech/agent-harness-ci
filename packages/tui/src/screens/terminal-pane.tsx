import { Box, Text } from "ink";
import type { TerminalStatus } from "@agent-harness/client-runtime";
import type { Span } from "../transcript/lines.js";
import { StyledLine } from "./transcript.js";

/**
 * The terminal pane on screen (docs/specs/tui.md, "The terminal pane"):
 * between the transcript and the composer, a header naming the
 * environment the terminal runs on and how its subscription stands, then
 * the emulator's rows as styled lines, each exactly as wide as the
 * terminal. The header is in colour while the pane has the keys.
 */

/** The rows the pane's terminal has: two fifths of the frame, between 3 and 16 (a chosen default). */
export const paneRows = (frameRows: number): number => Math.min(16, Math.max(3, Math.floor(frameRows * 0.4)));

const STATE: Readonly<Record<TerminalStatus | "opening", string | undefined>> = {
  opening: "opening…",
  "catching-up": "catching up…",
  live: undefined,
  unreachable: "reconnecting…",
  ended: "ended",
};

export const TerminalPaneView = (props: {
  readonly environment: string;
  readonly status: TerminalStatus | "opening";
  readonly focused: boolean;
  readonly rows: readonly (readonly Span[])[];
  readonly height: number;
  readonly hint: string;
}) => {
  const state = STATE[props.status];
  const shown = Array.from({ length: props.height }, (_, i) => props.rows[i] ?? []);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexShrink={0}>
        <Text wrap="truncate-end" {...(props.focused ? { color: "cyan" } : { dimColor: true })}>
          {"── terminal · "}
          {props.environment}
          {state !== undefined && ` · ${state}`}
          {!props.focused && ` · ${props.hint}`}
        </Text>
      </Box>
      {shown.map((spans, index) => (
        <StyledLine key={index} spans={spans} />
      ))}
    </Box>
  );
};

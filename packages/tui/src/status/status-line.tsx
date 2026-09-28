import { Box, Text } from "ink";
import type { Reading, Styled } from "./line.js";

/**
 * The status line's two rows under the composer (docs/specs/tui.md, "Status,
 * usage, pickers"): line one, what the next
 * message goes out as, with the plan windows at the right; line two, what
 * the run is doing and the keys, or the yellow hand-off offer. Each half
 * truncates rather than wraps, so the line keeps its height. It draws its
 * props: the words are `line.ts`'s.
 */

export interface StatusLineOne {
  /** Joined with ` · `. */
  readonly parts: readonly Styled[];
  readonly readings: readonly Reading[];
}

export type StatusLineTwo =
  | { readonly kind: "offer"; readonly text: string }
  | { readonly kind: "working"; readonly activity: Styled | undefined; readonly details: readonly string[]; readonly hints: string | undefined };

const Piece = (props: { readonly piece: Styled }) => (
  <Text {...(props.piece.color !== undefined && { color: props.piece.color })} bold={props.piece.bold ?? false} dimColor={props.piece.dim ?? false}>
    {props.piece.text}
  </Text>
);

export const StatusLine = (props: { readonly one: StatusLineOne; readonly two: StatusLineTwo }) => {
  const { one, two } = props;
  const quiet = two.kind === "working" ? [...two.details, ...(two.hints !== undefined ? [two.hints] : [])] : [];
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box justifyContent="space-between">
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            {one.parts.map((part, index) => (
              <Text key={index}>
                {index > 0 && <Text dimColor> · </Text>}
                <Piece piece={part} />
              </Text>
            ))}
          </Text>
        </Box>
        {one.readings.length > 0 && (
          <Box flexShrink={0} marginLeft={1}>
            <Text>
              {one.readings.map((reading, index) => (
                <Text key={index}>
                  {index > 0 && <Text dimColor> · </Text>}
                  <Text dimColor>{reading.label} </Text>
                  {reading.bar !== "" && (
                    <Text>
                      <Text {...(reading.tone !== undefined && { color: reading.tone })}>{reading.bar.replace(/░+$/, "")}</Text>
                      <Text dimColor>{reading.bar.slice(reading.bar.replace(/░+$/, "").length)}</Text>{" "}
                    </Text>
                  )}
                  <Text {...(reading.tone !== undefined && { color: reading.tone })} bold={reading.tone === "red"} dimColor={reading.tone === undefined}>
                    {reading.value}
                  </Text>
                </Text>
              ))}
            </Text>
          </Box>
        )}
      </Box>
      <Box>
        <Text wrap="truncate-end">
          {two.kind === "offer" ? (
            <Text color="yellow">{two.text}</Text>
          ) : (
            <>
              {two.activity !== undefined && <Piece piece={two.activity} />}
              {quiet.length > 0 && (
                <Text dimColor>
                  {two.activity !== undefined ? " · " : ""}
                  {quiet.join(" · ")}
                </Text>
              )}
              {two.activity === undefined && quiet.length === 0 && " "}
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
};

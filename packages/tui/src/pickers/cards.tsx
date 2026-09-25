import { Box, Text } from "ink";
import type { Span } from "../transcript/lines.js";
import type { PanelRow } from "./panel.js";

/**
 * The cards `/account`, `/handoff`, `/model`, `/mode`, `/containment` and
 * `/settings` open, and the sign-in (docs/specs/tui.md, "Status, usage,
 * pickers"): a list with a cursor, rows that cannot be chosen dim with
 * their reason, lines under the list, and a line being typed. Each draws its
 * props; what they hold is `panel.ts`'s.
 */

const Styled = (props: { readonly span: Span }) => (
  <Text
    {...(props.span.color !== undefined && { color: props.span.color })}
    dimColor={props.span.dim ?? false}
    bold={props.span.bold ?? false}
    italic={props.span.italic ?? false}
  >
    {props.span.text}
  </Text>
);

/** A line being typed, with its cursor at the end. */
export const TypedLine = (props: { readonly prompt: string; readonly text: string }) => (
  <Text wrap="wrap">
    <Text>{props.prompt} </Text>
    {props.text}
    <Text inverse> </Text>
  </Text>
);

export interface ListCardProps {
  readonly title: string;
  readonly hint: string;
  readonly rows: readonly PanelRow[];
  readonly cursor: number;
  /** The lines the list may take: it scrolls to keep the cursor in sight. */
  readonly height: number;
  /** Said under the title while the rows are not known yet, or when there are none. */
  readonly empty?: string;
  /** A line under the title about the whole list: why it is read-only. */
  readonly lead?: readonly Span[];
  /** Lines under the list: what the row at the cursor means, a failure. */
  readonly footer?: readonly (readonly Span[])[];
  /** The columns the card has: a footer line is counted by the rows it wraps to. */
  readonly width?: number;
  /** What follows the footer (a line being typed), and the rows it takes. */
  readonly children?: React.ReactNode;
  readonly childRows?: number;
}

/** The rows `text` wraps to in `width` columns less the card's padding; one without a width. */
export const wrappedRows = (text: string, width: number | undefined): number =>
  width === undefined ? 1 : Math.max(1, Math.ceil([...text].length / Math.max(1, width - 2)));

/** A list: its title and hint, the rows around the cursor (a row's line under it counted), the footer. */
export const ListCard = (props: ListCardProps) => {
  const footer = props.footer ?? [];
  const footerRows = footer.reduce((sum, line) => sum + wrappedRows(line.map((span) => span.text).join(""), props.width), 0);
  const room = Math.max(1, props.height - 1 - (props.lead !== undefined ? 1 : 0) - footerRows - (props.childRows ?? 0));
  const span = (row: PanelRow) => (row.under !== undefined ? 2 : 1);
  // The first row shown: enough before the cursor that it and the rows after it fit.
  let top = 0;
  let used = props.rows.slice(0, props.cursor + 1).reduce((sum, row) => sum + span(row), 0);
  while (used > room && top < props.cursor) {
    used -= span(props.rows[top] as PanelRow);
    top++;
  }
  let fits = 0;
  let shown = 0;
  for (const row of props.rows.slice(top)) {
    if (shown + span(row) > room) break;
    shown += span(row);
    fits++;
  }
  return (
    <Box flexDirection="column" paddingX={1} overflow="hidden">
      <Text bold wrap="truncate-end">
        {props.title} <Text dimColor>{props.hint}</Text>
      </Text>
      {props.lead !== undefined && (
        <Text wrap="truncate-end">
          {props.lead.map((span, at) => (
            <Styled key={at} span={span} />
          ))}
        </Text>
      )}
      {props.rows.length === 0 && props.empty !== undefined && <Text dimColor>{props.empty}</Text>}
      {props.rows.slice(top, top + fits).map((row, index) => {
        const selected = top + index === props.cursor;
        return (
          <Box key={row.key} flexDirection="column">
            <Text wrap="truncate-end" inverse={selected} dimColor={row.dim}>
              {selected ? "› " : "  "}
              {row.cells.map((cell, at) => (
                <Styled key={at} span={row.dim ? { ...cell, dim: true } : cell} />
              ))}
              {row.note !== undefined && (
                <Text>
                  {"  "}
                  <Styled span={row.note} />
                </Text>
              )}
            </Text>
            {row.under !== undefined && (
              <Text wrap="truncate-end">
                <Styled span={row.under} />
              </Text>
            )}
          </Box>
        );
      })}
      {footer.map((line, index) => (
        <Text key={`footer-${index}`} wrap="wrap">
          {line.map((span, at) => (
            <Styled key={at} span={span} />
          ))}
        </Text>
      ))}
      {props.children}
    </Box>
  );
};

const Lines = (props: { readonly lines: readonly (readonly Span[])[]; readonly prefix: string }) => (
  <>
    {props.lines.map((line, index) => (
      <Text key={`${props.prefix}-${index}`} wrap="wrap">
        {line.length === 0
          ? " "
          : line.map((span, at) => (
              <Styled key={at} span={span} />
            ))}
      </Text>
    ))}
  </>
);

/** A card of lines, as a sign-in shows its state: a title and hint, the lines, what is typed (`children`), then the lines after it. */
export const LinesPanel = (props: {
  readonly title: string;
  readonly hint: string;
  readonly lines: readonly (readonly Span[])[];
  readonly after?: readonly (readonly Span[])[];
  readonly children?: React.ReactNode;
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold wrap="truncate-end">
      {props.title} <Text dimColor>{props.hint}</Text>
    </Text>
    <Lines lines={props.lines} prefix="before" />
    {props.children}
    <Lines lines={props.after ?? []} prefix="after" />
  </Box>
);

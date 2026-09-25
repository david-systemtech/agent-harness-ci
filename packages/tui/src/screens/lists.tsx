import { Box, Text } from "ink";
import type { SessionRow } from "@agent-harness/client-runtime";
import type { SnippetTemplate } from "../composer/snippets.js";
import { oneLine } from "../transcript/format.js";

/**
 * The lists the transcript and composer open (docs/specs/tui.md, "The
 * composer"): `/resume`'s sessions, a filter typed at it, and `/snip`'s saved
 * snippets. Each draws its props; the cursor and the filter are the app's.
 */

const Row = (props: { readonly selected: boolean; readonly children: React.ReactNode }) => (
  <Text wrap="truncate-end" inverse={props.selected}>
    {props.selected ? "› " : "  "}
    {props.children}
  </Text>
);

/** The words a session's activity says in a list. */
const activityWords = (row: SessionRow): string => {
  const { state } = row.summary.activity;
  if (state === "parked") return `parked (${row.summary.parkedPromptCount})`;
  return state === "idle" ? "" : state;
};

/** `/resume`: the sessions of every environment, filtered by what is typed, the environment named on each. */
export const SessionsCard = (props: {
  readonly rows: readonly SessionRow[];
  readonly names: ReadonlyMap<string, string>;
  readonly cursor: number;
  readonly filter: string;
  readonly height: number;
  readonly hint: string;
}) => {
  const top = Math.max(0, Math.min(props.cursor - Math.floor(props.height / 2), props.rows.length - props.height));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        Sessions <Text dimColor>{props.hint}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>filter </Text>
        {props.filter}
        <Text inverse> </Text>
      </Text>
      {props.rows.length === 0 && <Text dimColor>{props.filter.length > 0 ? "No session matches." : "No session to resume."}</Text>}
      {props.rows.slice(top, top + props.height).map((row, index) => (
        <Row key={`${row.environmentId} ${row.summary.id}`} selected={top + index === props.cursor}>
          <Text dimColor>{(props.names.get(row.environmentId) ?? "").slice(0, 12).padEnd(13)}</Text>
          {oneLine(row.summary.title, 60)}
          <Text dimColor> {activityWords(row)}</Text>
        </Row>
      ))}
    </Box>
  );
};

/** `/snip`: the saved snippets, the first line of each body beside its name; Enter expands one into the composer. */
export const SnippetsCard = (props: { readonly rows: readonly SnippetTemplate[]; readonly cursor: number; readonly hint: string }) => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold wrap="truncate-end">
      Snippets <Text dimColor>{props.hint}</Text>
    </Text>
    {props.rows.map((row, index) => (
      <Row key={row.name} selected={index === props.cursor}>
        {row.name.padEnd(20)}
        <Text dimColor>{oneLine(row.body, 60)}</Text>
      </Row>
    ))}
  </Box>
);

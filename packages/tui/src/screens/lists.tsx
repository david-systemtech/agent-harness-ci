import { Box, Text } from "ink";
import { oneLine, type SessionRow, type UserMessageEntry, type VerbAvailability } from "@agent-harness/client-runtime";
import type { SnippetTemplate } from "../composer/snippets.js";
import { ListCard } from "../pickers/cards.js";
import { messageWords } from "../session/use-fork-rewind.js";
import type { Span } from "../transcript/lines.js";
import { clockTime } from "../view.js";

/**
 * The lists the transcript and composer open (docs/specs/tui.md, "The
 * composer" and "The transcript"): `/resume`'s sessions, a filter typed at
 * it, `/snip`'s saved snippets, and Esc Esc's prompt picker. Each draws its
 * props; the cursor and the filter are the app's.
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

/**
 * Esc Esc: the prompt picker (ADR 0022; #232), #147's `ListCard`, not typed
 * at: the session's user messages a run has read, oldest first, each its
 * first line and its time. Under them: that files stay as they are, then
 * each of its two actions that cannot be used now, dim with the runtime's
 * reason, never hidden; a rewind while a run can be stopped is offered as a
 * stop and a rewind.
 */
export const PromptPickerCard = (props: {
  readonly messages: readonly UserMessageEntry[];
  readonly cursor: number;
  readonly width: number;
  readonly height: number;
  /** The keys of the map in force: move, rewind (choose), branch and close. */
  readonly keys: { readonly move: string; readonly choose: string; readonly branch: string; readonly leave: string };
  readonly rewind: VerbAvailability | undefined;
  readonly fork: VerbAvailability | undefined;
  readonly offersStop: boolean;
}) => {
  const { keys, rewind, fork } = props;
  const footer: (readonly Span[])[] = [
    [{ text: "Files are not restored: a rewind or a branch takes back the conversation, never the files the agent changed.", dim: true }],
    ...(props.offersStop
      ? [[{ text: `A run is live: ${keys.choose} stops it, then rewinds here.`, color: "yellow" }]]
      : rewind?.status === "absent"
        ? [[{ text: `${keys.choose} rewind (${rewind.message})`, dim: true }]]
        : []),
    ...(fork?.status === "absent" ? [[{ text: `${keys.branch} branch (${fork.message})`, dim: true }]] : []),
  ];
  return (
    <ListCard
      width={props.width}
      title="Prompts"
      hint={`${keys.move} move · ${keys.choose} rewinds here · ${keys.branch} branches here · ${keys.leave} closes`}
      rows={props.messages.map((message) => ({ key: message.messageId, cells: [{ text: messageWords(message.text) }], dim: false, note: { text: clockTime(message.sentAt), dim: true } }))}
      cursor={props.cursor}
      height={props.height}
      empty="No prompt to go back to."
      footer={footer}
    />
  );
};

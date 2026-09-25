import { Box, Text } from "ink";
import { asksHeading, decidable, type AskRow } from "../cards/asks.js";

/**
 * The parked-asks card on screen (docs/specs/tui.md, "Cards"; Artemis's
 * `AsksCard.tsx` at 443cf2e): a heading counting the prompts, a row each
 * with a two-cell gutter for the cursor, the environment's badge, the
 * session's title (`(here)` for the one on screen), what it asks in the
 * colour of the card it opens into, and its TTL countdown; the legend under
 * it names only the keys the row under the cursor answers.
 */

/** A kind's word in the colour of the card it opens into. */
const KIND_COLOURS: Readonly<Record<string, string>> = { question: "magenta", plan: "blue", denylist: "red" };

export interface AsksCardProps {
  readonly rows: readonly AskRow[];
  readonly cursor: number;
  /** The legends for a row `y` and `n` answer, and for one they do not, in the keys of the map in force. */
  readonly hint: { readonly decidable: string; readonly other: string };
  /** The rows' height before they scroll. */
  readonly height: number;
}

export const AsksCard = (props: AsksCardProps) => {
  const { rows } = props;
  const at = Math.min(Math.max(props.cursor, 0), Math.max(0, rows.length - 1));
  const top = Math.max(0, Math.min(at - props.height + 1, rows.length - props.height));
  const shown = rows.slice(top, top + props.height);
  const row = rows[at];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⚿ {asksHeading(rows.length)}
      </Text>
      {shown.map((item, index) => {
        const selected = top + index === at;
        return (
          <Text key={item.key} wrap="truncate-end">
            <Text color="yellow">{selected ? "❯ " : "  "}</Text>
            <Text color={item.badge.colour}>{item.badge.abbreviation}</Text>
            <Text> </Text>
            <Text bold={selected}>{item.title}</Text>
            {item.here && <Text dimColor> (here)</Text>}
            <Text>{"  "}</Text>
            {item.kindWord.length > 0 && <Text color={KIND_COLOURS[item.kindWord] ?? "yellow"}>{item.kindWord} </Text>}
            <Text dimColor={!selected}>{item.detail}</Text>
            {item.ttl !== undefined && <Text dimColor>{` · ${item.ttl}`}</Text>}
          </Text>
        );
      })}
      {rows.length > shown.length && <Text dimColor>{`${rows.length - shown.length} more`}</Text>}
      <Text dimColor wrap="wrap">
        {row !== undefined && decidable(row.ask.kind) ? props.hint.decidable : props.hint.other}
      </Text>
    </Box>
  );
};

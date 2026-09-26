import { Box, Text } from "ink";
import { FILES_LIST_CAP } from "@agent-harness/contracts";
import type { BrowseRow } from "../files/browse.js";

/**
 * `/files`' picker on screen (docs/specs/tui.md, "The composer"): the
 * directory it shows under the workspace, a filter typed at it, the rows
 * with the cursor, and a mark when the environment cut the listing at its
 * 20,000 entries. Draws its props; the directory, the filter and the cursor
 * are the app's.
 */
export const FilesCard = (props: {
  readonly workspace: string;
  readonly dir: string;
  readonly rows: readonly BrowseRow[] | null;
  readonly truncated: boolean;
  readonly cursor: number;
  readonly filter: string;
  readonly height: number;
  readonly hint: string;
}) => {
  const rows = props.rows ?? [];
  const height = Math.max(1, props.height - (props.truncated ? 1 : 0));
  const top = Math.max(0, Math.min(props.cursor - Math.floor(height / 2), rows.length - height));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate-end">
        Files · {props.dir === "" ? props.workspace : `${props.workspace}/${props.dir}`} <Text dimColor>{props.hint}</Text>
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>filter </Text>
        {props.filter}
        <Text inverse> </Text>
      </Text>
      {props.truncated && (
        <Text color="yellow" wrap="truncate-end">
          The workspace holds more than {FILES_LIST_CAP.toLocaleString("en-GB")} files: this listing is cut.
        </Text>
      )}
      {props.rows === null && <Text dimColor>Listing the workspace…</Text>}
      {props.rows !== null && rows.length === 0 && <Text dimColor>{props.filter.length > 0 ? "No file matches." : "Nothing here."}</Text>}
      {rows.slice(top, top + height).map((row, index) => {
        const selected = top + index === props.cursor;
        return (
          <Text key={`${row.kind} ${row.path}`} wrap="truncate-end" inverse={selected}>
            {selected ? "› " : "  "}
            {row.kind === "file" ? row.name : <Text color="cyan">{row.name}</Text>}
            {row.kind === "dir" && <Text dimColor> {row.files === 1 ? "1 file" : `${String(row.files)} files`}</Text>}
          </Text>
        );
      })}
    </Box>
  );
};

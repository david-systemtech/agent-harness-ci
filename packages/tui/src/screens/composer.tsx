import { Box, Text } from "ink";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { cursorPosition, editorWindow, lines as editorLines, type EditorState } from "../composer/editor.js";
import type { CommandRow, Popup } from "../composer/state.js";

/**
 * The composer on screen (docs/specs/tui.md, "The composer"): a box,
 * growing with the text to eight lines and then scrolling, the cursor drawn
 * as an inverse cell while it has the keys, the popup under it (commands,
 * `@` paths, snippets), the reverse search's row, and a dim note (a history
 * walk's place, the snippet stops left, what goes attached). Locked, it says
 * why in one line and takes nothing (`capability`, ADR 0004). On a session
 * whose workspace is missing (#328) the empty box is replaced by the gone
 * path and a Choose a workspace line, which stays under what is typed.
 */

/** Lines drawn before the box scrolls. */
export const COMPOSER_ROWS = 8;

export interface ComposerViewProps {
  readonly editor: EditorState;
  readonly focused: boolean;
  /** Why nothing can be sent now; undefined when it can. */
  readonly locked: string | undefined;
  /** The open session's workspace, when the environment has found it gone; undefined while it is there. */
  readonly gone?: string | undefined;
  /** What the empty box says. */
  readonly placeholder: string;
  readonly popup: Popup | null;
  readonly highlight: number;
  readonly search: { readonly query: string; readonly scope: string; readonly found: boolean } | undefined;
  /** A dim line under the box, when there is something to say. */
  readonly note: string | undefined;
}

const cellAt = (line: string, col: number): string => {
  const code = line.codePointAt(col);
  return code === undefined ? " " : String.fromCodePoint(code);
};

/** One line of the buffer, the cursor's cell inverse when it is on this line. */
const BufferLine = (props: { readonly text: string; readonly cursor: number | undefined; readonly lead: string; readonly leadColor?: string; readonly dim: boolean }) => {
  const { text, cursor } = props;
  const cell = cursor === undefined ? "" : cellAt(text, cursor);
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-start" dimColor={props.dim}>
        <Text {...(props.leadColor !== undefined && { color: props.leadColor })}>{props.lead}</Text>
        {cursor === undefined ? (
          text
        ) : (
          <>
            {text.slice(0, cursor)}
            <Text inverse>{cell}</Text>
            {text.slice(cursor + (cell === " " && cursor >= text.length ? 0 : cell.length))}
          </>
        )}
      </Text>
    </Box>
  );
};

/** What a slash menu row says after its usage: its description, marked when the agent's own or a slash-only skill. */
const rowNote = (row: CommandRow): string => (row.source === "provider" ? `${row.description} · the agent's` : row.slashOnly ? `${row.description} · slash-only` : row.description);

/** The popup's rows, the highlighted one inverse. */
const PopupRows = (props: { readonly popup: Popup; readonly highlight: number }) => {
  const { popup } = props;
  if (popup.kind === "mentions" && popup.rows.length === 0) {
    return (
      <Text dimColor wrap="truncate-end">
        {"    "}
        {popup.loading ? "listing the workspace…" : "no match"}
      </Text>
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0}>
      {popup.kind === "commands" &&
        popup.rows.map((row, index) => (
          <Text key={row.name} wrap="truncate-end" inverse={index === props.highlight}>
            {"    "}
            {row.usage.padEnd(22)} <Text dimColor>{rowNote(row)}</Text>
          </Text>
        ))}
      {popup.kind === "mentions" &&
        popup.rows.map((row, index) => (
          <Text key={row.path} wrap="truncate-end" inverse={index === props.highlight}>
            {"    @"}
            {row.path}
          </Text>
        ))}
      {popup.kind === "snippets" &&
        popup.rows.map((row, index) => (
          <Text key={row.name} wrap="truncate-end" inverse={index === props.highlight}>
            {"    ;;"}
            {row.name.padEnd(18)} <Text dimColor>{(row.body.split("\n", 1)[0] ?? "").slice(0, 48)}</Text>
          </Text>
        ))}
    </Box>
  );
};

export const ComposerView = (props: ComposerViewProps) => {
  const { editor, focused } = props;
  const all = editorLines(editor);
  const { row, col } = cursorPosition(editor);
  const window = editorWindow(row, all.length, COMPOSER_ROWS);
  const shown = all.slice(window.top, window.top + window.size);
  const empty = editor.text.length === 0;
  const barred = props.locked !== undefined || props.gone !== undefined;
  const glyph = barred ? "✕ " : "› ";
  const glyphColor = barred ? TERMINAL_ROLES.warning : focused ? TERMINAL_ROLES.machine : undefined;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {window.top > 0 && (
        <Text dimColor wrap="truncate-end">
          {"  "}↑ {window.top} more line{window.top === 1 ? "" : "s"}
        </Text>
      )}
      {empty && props.gone !== undefined ? (
        <Box flexShrink={0}>
          <Text wrap="truncate-end">
            <Text color={TERMINAL_ROLES.warning}>{glyph}</Text>
            {props.gone} is gone
          </Text>
        </Box>
      ) : empty ? (
        <Box flexShrink={0}>
          <Text wrap="truncate-end" dimColor={!focused}>
            <Text {...(glyphColor !== undefined && { color: glyphColor })}>{glyph}</Text>
            {focused && <Text inverse> </Text>}
            <Text dimColor>{props.placeholder}</Text>
          </Text>
        </Box>
      ) : (
        shown.map((text, index) => (
          <BufferLine
            key={window.top + index}
            text={text}
            cursor={focused && window.top + index === row ? col : undefined}
            lead={window.top + index === 0 ? glyph : "  "}
            {...(window.top + index === 0 && glyphColor !== undefined && { leadColor: glyphColor })}
            dim={!focused}
          />
        ))
      )}
      {window.top + window.size < all.length && (
        <Text dimColor wrap="truncate-end">
          {"  "}↓ {all.length - window.top - window.size} more line{all.length - window.top - window.size === 1 ? "" : "s"}
        </Text>
      )}
      {props.locked !== undefined && (
        <Text color={TERMINAL_ROLES.warning} wrap="truncate-end">
          {"  "}Locked: {props.locked}
        </Text>
      )}
      {props.gone !== undefined && (
        <Text color={TERMINAL_ROLES.warning} wrap="truncate-end">
          {"  "}Choose a workspace: /cwd
        </Text>
      )}
      {props.search && (
        <Text wrap="truncate-end">
          {"  "}
          <Text color={TERMINAL_ROLES.machine}>(search {props.search.scope})</Text> {props.search.query}
          {!props.search.found && props.search.query.length > 0 && <Text dimColor> · no match</Text>}
        </Text>
      )}
      {focused && props.popup && <PopupRows popup={props.popup} highlight={props.highlight} />}
      {props.note !== undefined && (
        <Text dimColor wrap="truncate-end">
          {"  "}
          {props.note}
        </Text>
      )}
    </Box>
  );
};

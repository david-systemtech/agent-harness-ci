import { fuzzyMatch, matchCommands, mentionAt, type CachedAnswer, type FileMatch, type Mention } from "@agent-harness/client-runtime";
import type { MouseEvent, ReactNode } from "react";
import { classes } from "../ui/classes.js";

/**
 * The composer's two menus (docs/specs/gui.md, "A session pane"; #400), one
 * at a time, as the terminal UI opens them: the slash menu while the text is
 * one word after a `/` and the caret at its end, listing the commands the
 * window wires and the provider's own (`commands.list`) in the runtime's
 * order (`matchCommands`); and the files while the caret is in an `@` token,
 * the session's workspace from `files.list` ranked by the runtime's scorer
 * (`fuzzyMatch`) as the token is typed. Each menu has a key naming what it
 * was opened over, so a highlight or an Esc belongs to that text alone.
 */

/** A row of the slash menu: a command the window wired, or the provider's own, which goes to the agent as typed. */
export interface CommandRow {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly provider: boolean;
}

export type Menu =
  | { readonly kind: "commands"; readonly key: string; readonly rows: readonly CommandRow[] }
  | {
      readonly kind: "files";
      readonly key: string;
      readonly mention: Mention;
      readonly rows: readonly FileMatch[];
      /** What the list says instead of rows, or beside them: still listing, cannot list, no match. */
      readonly note: string | undefined;
    };

/** Rows offered at once. */
export const MENU_ROWS = 8;

/** The one word after a `/` the text is while the slash menu is open, the caret at its end; undefined otherwise. */
export const slashWord = (text: string, caret: number): string | undefined => {
  const word = /^\/(\S*)$/.exec(text)?.[1];
  return word !== undefined && caret === text.length ? word : undefined;
};

/**
 * The menu `text` opens with the caret at `caret`, if any: the slash menu
 * over `commands`, else the files over the workspace's listing (`files`,
 * undefined while nobody has asked for it).
 */
export const menuOf = (text: string, caret: number, commands: readonly CommandRow[], files: CachedAnswer<"files.list"> | undefined): Menu | null => {
  const word = slashWord(text, caret);
  if (word !== undefined) {
    const rows = matchCommands(word, commands).slice(0, MENU_ROWS);
    return rows.length === 0 ? null : { kind: "commands", key: `commands ${text}`, rows };
  }
  const mention = mentionAt(text, caret);
  if (mention === null) return null;
  const listed = files?.result;
  const rows = listed ? fuzzyMatch(mention.query, listed.files, { limit: MENU_ROWS }) : [];
  const note =
    listed === undefined || listed === null
      ? files?.error
        ? `The workspace cannot be listed: ${files.error.message}`
        : "Listing the workspace…"
      : rows.length === 0
        ? "No file in the workspace matches."
        : undefined;
  return { kind: "files", key: `files ${String(mention.start)} ${mention.query}`, mention, rows, note };
};

/** The highlighted row of `menu`: the one chosen over its text, else the first; -1 when it offers none. */
export const highlighted = (menu: Menu, highlight: { readonly key: string; readonly index: number } | null): number => {
  if (menu.rows.length === 0) return -1;
  return highlight?.key === menu.key ? Math.min(Math.max(highlight.index, 0), menu.rows.length - 1) : 0;
};

interface MenuListProps {
  readonly id: string;
  readonly menu: Menu;
  readonly highlighted: number;
  readonly choose: (index: number) => void;
}

/** The ids of a menu's rows, which the box names as the one highlighted. */
export const optionId = (listId: string, index: number) => `${listId}-${String(index)}`;

/** Keeps the focus in the box while a row is pressed. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** A menu drawn over the box: its rows, the highlighted one washed, a click choosing one; its note under them. */
export const MenuList = ({ id, menu, highlighted: at, choose }: MenuListProps) => {
  const option = (key: string, index: number, content: ReactNode) => (
    <li
      key={key}
      role="option"
      id={optionId(id, index)}
      aria-selected={index === at}
      onMouseDown={keepFocus}
      onClick={() => choose(index)}
      className={classes("flex cursor-default items-baseline gap-2 rounded-sm px-2 py-1", index === at && "bg-wash")}
    >
      {content}
    </li>
  );
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line-strong bg-float p-1 text-sm text-ink">
      {menu.rows.length > 0 && (
        <ul role="listbox" id={id} aria-label={menu.kind === "commands" ? "Commands" : "Files"} className="flex flex-col">
          {menu.kind === "commands"
            ? menu.rows.map((row, index) => option(row.name, index, <CommandOption row={row} />))
            : menu.rows.map((row, index) => option(row.path, index, <span className="font-mono text-xs">{row.path}</span>))}
        </ul>
      )}
      {menu.kind === "files" && menu.note !== undefined && <p className="px-2 py-1 text-xs text-ink-muted">{menu.note}</p>}
    </div>
  );
};

const CommandOption = ({ row }: { readonly row: CommandRow }) => (
  <>
    <span className="font-mono text-xs">/{row.name}</span>
    <span className="min-w-0 truncate text-xs text-ink-muted">
      {row.description}
      {row.provider && " · the agent's"}
    </span>
  </>
);

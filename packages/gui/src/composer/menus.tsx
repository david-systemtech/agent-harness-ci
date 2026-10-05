import { fuzzyMatch, matchCommands, mentionAt, slashMenuRows, type CachedAnswer, type FileMatch, type Mention, type SlashMenuRow } from "@agent-harness/client-runtime";
import type { AdapterCapabilities } from "@agent-harness/contracts";
import { useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { File, SquareTerminal } from "lucide-react";
import { classes } from "../ui/classes.js";
import { useFollowed, useRuntime } from "../window-context.js";
import { useLocalEscapeStep } from "../keys/key-dispatch.js";
import { typedCommand, useWiredCommands } from "./slash-commands.js";

/**
 * The composer's two menus (docs/specs/gui.md, "A session pane"; #400), one
 * at a time, as the terminal UI opens them: the slash menu while the text is
 * one word after a `/` and the caret at its end, listing the commands the
 * window wires, then the session's skills and the provider's own
 * (`commands.list`, #503), as the runtime lists them (`slashMenuRows`) and
 * in its order (`matchCommands`); and the files while the caret is in an `@` token,
 * the session's workspace from `files.list` ranked by the runtime's scorer
 * (`fuzzyMatch`) as the token is typed. Each menu has a key naming what it
 * was opened over, so a highlight or an Esc belongs to that text alone.
 */

/** A row of the slash menu: a command the window wired, a skill of the session's set, or the provider's own (#503). */
export type CommandRow = SlashMenuRow & { readonly unavailable?: string | undefined };

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

/** Whether a command of the shared list takes `/<name>` in the window, which the provider's command or a skill of that name then yields to. */
const answers = (name: string): boolean => typedCommand(`/${name}`) !== undefined;

export interface MenusHost {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly provider: AdapterCapabilities | undefined;
  /** The box's text and where its caret is. */
  readonly text: string;
  readonly caret: number;
}

export interface Menus {
  /** The menu open over the box, if any. */
  readonly open: Menu | null;
  /** Its highlighted row; -1 with none. */
  readonly at: number;
  /** The id its list is drawn under, which the box names. */
  readonly listId: string;
  /** A menu's own keys, before the composer's: ↑ and ↓ move its highlight, Esc puts it away until the text changes. */
  keyDown(event: KeyboardEvent): void;
}

/**
 * The menu the box opens, over what each needs: the commands wired, and the
 * session's skills and the provider's own while its adapter lists them
 * (`commands.list` for the session, asked while the text begins with a `/`),
 * and the workspace's files (`files.list`, asked while a file is being
 * named), both through the request cache.
 */
export const useMenus = ({ environmentId, sessionId, provider, text, caret }: MenusHost): Menus => {
  const runtime = useRuntime();
  const wired = useWiredCommands();
  const listing = text.startsWith("/") && provider?.commands === true;
  const provided = useFollowed(
    useMemo(() => (listing ? runtime.requests.cached(environmentId, "commands.list", { sessionId }) : undefined), [runtime, environmentId, sessionId, listing]),
  );
  const naming = mentionAt(text, caret) !== null;
  const files = useFollowed(useMemo(() => (naming ? runtime.requests.cached(environmentId, "files.list", { sessionId }) : undefined), [runtime, environmentId, sessionId, naming]));
  const commands = useMemo(() => slashMenuRows(wired, provided?.result?.entries ?? [], answers).map((row) => ({
    ...row,
    unavailable: row.source === "client" ? wired.find((command) => command.name === row.name)?.unavailable : undefined,
  })), [wired, provided]);
  const [highlight, setHighlight] = useState<{ readonly key: string; readonly index: number } | null>(null);
  const [dismissed, dismiss] = useState<string | null>(null);
  const listId = useId();

  const menu = menuOf(text, caret, commands, files);
  const open = menu !== null && menu.key !== dismissed ? menu : null;
  const at = open === null ? -1 : highlighted(open, highlight);
  useLocalEscapeStep("surface", () => { if (open !== null) dismiss(open.key); }, open !== null);
  return {
    open,
    at,
    listId,
    keyDown(event) {
      if (event.defaultPrevented || open === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "Escape") dismiss(open.key);
      else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && open.rows.length > 0) {
        setHighlight({ key: open.key, index: (at + (event.key === "ArrowUp" ? -1 : 1) + open.rows.length) % open.rows.length });
      } else return;
      event.preventDefault();
    },
  };
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
  const option = (key: string, index: number, content: ReactNode, unavailable?: string) => (
    <li
      key={key}
      role="option"
      id={optionId(id, index)}
      aria-selected={index === at}
      aria-disabled={unavailable === undefined ? undefined : true}
      title={`${unavailable === undefined ? "" : `${unavailable} · `}↑/↓ choose · Tab completes · Enter accepts · Escape closes`}
      onMouseDown={keepFocus}
      onClick={() => choose(index)}
      className={classes("flex cursor-default items-center gap-2 rounded-md px-2.5 py-1", index === at && "bg-wash-strong", unavailable !== undefined && "opacity-50")}
    >
      {content}
    </li>
  );
  return (
    <div data-composer-menu className="absolute bottom-full left-0 z-20 mb-1.5 flex max-h-64 w-full flex-col gap-1 overflow-y-auto rounded-xl border border-hairline-strong bg-float p-1 text-sm text-ink shadow-lg shadow-scrim/40">
      {menu.rows.length > 0 && (
        <ul role="listbox" id={id} aria-label={menu.kind === "commands" ? "Commands" : "Files"} className="flex flex-col">
          {menu.kind === "commands"
            ? menu.rows.map((row, index) => option(row.name, index, <CommandOption row={row} />, row.unavailable))
            : menu.rows.map((row, index) => option(row.path, index, <><File aria-hidden="true" className="size-3 shrink-0" /><span className="truncate font-mono text-sm">{row.path}</span></>))}
        </ul>
      )}
      {menu.kind === "files" && menu.note !== undefined && <p className="px-2 py-1 text-xs text-ink-muted">{menu.note}</p>}
    </div>
  );
};

const CommandOption = ({ row }: { readonly row: CommandRow }) => (
  <>
    <SquareTerminal aria-hidden="true" className="size-3 shrink-0" /><span className="shrink-0 font-mono text-sm">/{row.name}</span>
    <span className="min-w-0 truncate text-xs text-ink-muted">
      {row.unavailable ?? row.description}

    </span>
    <span className="ml-auto shrink-0 text-2xs text-ink-faint"> · {row.source === "provider" ? "the agent's" : row.source}{row.slashOnly && " · slash-only"}</span>
  </>
);

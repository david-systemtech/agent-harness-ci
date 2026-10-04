import type { SessionRow } from "@agent-harness/client-runtime";
import { ACTION_GROUPS, SETTINGS_ROWS, isCommandId, type ActionId, type ListedAction } from "@agent-harness/contracts";
import { Command } from "cmdk";
import { Dialog as RadixDialog } from "radix-ui";
import { ArrowDownToLine, ArrowUpFromLine, BookOpen, CircleStop, Cpu, FileText, Folder, GitBranch, GitFork, History, Info, Keyboard, ListChecks, MessageSquare, PanelLeft, Paperclip, Search, SendHorizontal, Settings2, Shield, SquareSplitHorizontal, SquareSplitVertical, SquareTerminal, Undo2, Globe, X, type LucideIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { showSession } from "../grid/layout.js";
import { keyLabel } from "../keys/chords.js";
import { KeyContext, useEveryWiredAction, useIsKeyOf, useKeyAction, useKeyMap, useMacOS, type Offer, type WiredAction } from "../keys/key-dispatch.js";
import { keysInForce } from "../keys/key-map.js";
import { dimReason } from "../settings/rail.js";
import { useSettings } from "../settings/settings-window.js";
import { environmentColour } from "../theme/paint.js";
import { CommandInput, CommandList } from "../ui/command.js";
import { Kbd } from "../ui/kbd.js";
import { IconButton } from "../ui/button.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The command palette (docs/specs/gui.md, "The window and the sidebar";
 * stories 4 and 9; #406), opened over the window by Mod+K (`app.palette`),
 * over cmdk. Its first page lists every action the window has wired
 * (`useEveryWiredAction`), in the window's presentation groups and registry order, each with
 * its GUI keys in force (this client's remaps read over the defaults), the
 * slash commands the window wires last among them; its last entry opens the
 * sessions page, which finds a session on every environment through
 * `projections.search` and opens it in the focused pane. Every row of Settings is listed after the actions, by its
 * label and old names, and opens Settings on it. Typing filters a page;
 * choosing an entry closes the palette, gives the focus back to where it
 * was, and runs it there.
 *
 * - **What is listed** is what the keys would do as the palette opens: an
 *   action whose keys the column answers under a condition (the find bar's,
 *   ↑ in an empty composer) is listed only when it held then.
 *   The palette's own actions (its list's keys, and Mod+K) are not listed.
 * - **Dim**: an entry the connection or the shell cannot offer now stays,
 *   dim with its reason under it (the wiring surface's offer, in the
 *   runtime's words), and cannot be chosen: cmdk passes over it.
 * - **Keys**: its list's keys are the picker's, dispatched as every key is
 *   (`picker.move`, `picker.choose`, `picker.leave`, and `picker.back` at an
 *   empty query). cmdk keeps the highlight, scrolls to it and names it to
 *   the query field only when it moves the highlight itself, so a move or a
 *   choice hands cmdk the key its list answers.
 * - **Modal**: the window under it is inert while it is open, and a key
 *   the palette does not answer goes no further than it, but the one that
 *   closes it (`app.palette`'s); a press outside it closes it.
 */

/** The palette's words for an action whose shared-list words are the terminal's, or longer than the window says it: "Stop the run" is `app.interrupt`. */
const NAMES: Partial<Readonly<Record<ActionId, string>>> = {
  "app.interrupt": "Stop the run",
  "app.session.new": "New session",
  "app.session.newInPane": "New session in a new pane",
};

/** An action the palette itself answers, which it does not list: its list's keys, and the key that opens it. */
const answeredByPalette = (action: ListedAction): boolean => action.context === "picker" || action.id === "app.palette";

const PRESENT: Offer = { status: "present" };

/** One entry of a page. */
interface Entry {
  /** cmdk's value for it: unique on its page. */
  readonly value: string;
  readonly name: string;
  readonly icon: LucideIcon;
  readonly metadata?: ReactNode;
  readonly swatch?: ReactNode;
  /** What is said beside its name: a slash command's description, a Settings row's old names, a session's environment. */
  readonly detail?: string;
  /** Its GUI keys in force, as this platform reads them. */
  readonly keys: readonly string[];
  readonly offer: Offer;
  choose(): void;
}

interface EntryGroup {
  readonly heading: string;
  readonly entries: readonly Entry[];
}

/** Whether every word typed is in the entry's name or detail, ignoring case. */
const matches = (entry: Entry, query: string): boolean => {
  const text = `${entry.name} ${entry.detail ?? ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((word) => text.includes(word));
};

type Page = "root" | "sessions";

/** Each page's query field, named. */
const LABELS: Readonly<Record<Page, string>> = { root: "Search the commands", sessions: "Search the sessions on every environment" };
const PLACEHOLDERS: Readonly<Record<Page, string>> = { root: "Type a command, or a session's title", sessions: "Titles, tags, group names, repositories" };

interface PaletteProps {
  /** The wired actions it lists: those whose keys' condition held as it opened. */
  readonly listed: ReadonlySet<ActionId>;
  /** Closes it, gives the focus back to where it was, then does `then` there. */
  readonly close: (then?: () => void) => void;
}

const Palette = ({ listed, close }: PaletteProps) => {
  const [page, setPage] = useState<Page>("root");
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const closes = useIsKeyOf("app.palette");
  /** Hands cmdk the key its list answers: it moves the highlight, or chooses the highlighted entry. */
  const press = (key: "ArrowUp" | "ArrowDown" | "Enter") => root.current?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  /** Back to the first page, from the sessions page; nothing to go back to from the first. */
  const back = (): false | void => {
    if (page === "root") return false;
    setPage("root");
  };

  return (
    <RadixDialog.Root open onOpenChange={open => { if (!open) close(); }}>
    <RadixDialog.Portal><RadixDialog.Content asChild aria-describedby={undefined} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
    <div
      data-palette-overlay
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-scrim/10 px-4 pt-[33.333vh] pb-4 backdrop-blur-[4px]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        // The window's keys would act on the window under it: only the one that closes it goes on to the window.
        if (!closes(event.nativeEvent)) event.stopPropagation();
      }}
    >
      <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
      <Command
        ref={root}
        label={LABELS[page]}
        shouldFilter={false}
        vimBindings={false}
        loop
        data-measure="palette"
        className="flex w-[384px] max-w-[min(620px,100%)] shrink-0 flex-col overflow-hidden rounded-xl bg-float text-ink ring-1 ring-ink/10"
      >
        <KeyContext context="picker" conditions={{ "picker.queryEmpty": () => query.length === 0 }}>
          <PickerKeys move={(key) => press(key === 0 ? "ArrowUp" : "ArrowDown")} choose={() => press("Enter")} leave={() => close()} back={back} />
          <div className="flex items-center justify-end px-1 pt-1 min-[640px]:hidden"><IconButton label="Close command palette" onClick={() => close()}><X aria-hidden="true" /></IconButton></div>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={PLACEHOLDERS[page]}
            title={`${LABELS[page]} — use the arrow keys to move and Enter to choose`}
          />
          {/* A press on the list leaves the focus in the query, so what is typed after choosing a page, or a dim entry, filters. */}
          <CommandList
            onMouseDown={(event) => event.preventDefault()}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-muted"
          >
            {page === "root" ? (
              <FirstPage listed={listed} query={query.trim()} close={close} toSessions={() => setPage("sessions")} />
            ) : (
              <SessionsPage query={query.trim()} close={close} />
            )}
          </CommandList>
        </KeyContext>
      </Command>
    </div>
    </RadixDialog.Content></RadixDialog.Portal></RadixDialog.Root>
  );
};

/**
 * The first page: the listed actions the query matches, in presentation
 * groups and registry order within each; the rows of Settings it matches, by label and old names
 * (docs/specs/gui.md, "Settings": opened from the palette), a placeholder row
 * dim with its reason; and last, whatever is typed, the way to the sessions
 * page, so a session's title typed here is one Enter from its page.
 */
const FirstPage = ({ listed, query, close, toSessions }: PaletteProps & { readonly query: string; readonly toSessions: () => void }) => {
  const macOS = useMacOS();
  const map = useKeyMap();
  const wired = useEveryWiredAction();
  const settings = useSettings();
  const entryOf = (action: ListedAction, wiredAction: WiredAction): Entry => {
    const command = isCommandId(action.id);
    return {
      value: action.id,
      name: NAMES[action.id] ?? (command ? `/${action.id.slice("command.".length)}` : action.description),
      icon: iconOf(action.id),
      ...(command && { detail: action.description }),
      keys: keysInForce(action, map).map((key) => keyLabel(key, macOS)),
      offer: wiredAction.offer,
      choose: () => close(wiredAction.run),
    };
  };
  const entries = ACTION_GROUPS.flatMap((group) => (group.actions as readonly ListedAction[]).flatMap((action) => {
    const wiredAction = wired.findLast((candidate) => candidate.id === action.id);
    return wiredAction === undefined || !listed.has(action.id) || answeredByPalette(action) ? [] : [{ action, entry: entryOf(action, wiredAction) }];
  })).filter(({ entry }) => matches(entry, query));
  const groups = (["Session", "Configure", "Settings", "Inspect"] as const).map((heading): EntryGroup => ({
    heading,
    entries: entries.filter(({ action }) => headingOf(action) === heading).map(({ entry }) => entry),
  }));
  const rows = SETTINGS_ROWS.map((row): Entry => {
    const dim = dimReason(row);
    return {
      value: `settings ${row.id}`,
      name: row.label,
      icon: Settings2,
      detail: row.terms.join(", "),
      keys: [],
      offer: dim === undefined ? PRESENT : { status: "absent", message: dim },
      choose: () => close(() => settings.open(row.id)),
    };
  }).filter((entry) => matches(entry, query));
  const sessions: Entry = {
    value: "sessions",
    name: query === "" ? "Sessions on every environment…" : `Sessions on every environment matching “${query}”`,
    icon: History,
    keys: [],
    offer: PRESENT,
    choose: toSessions,
  };
  return <Groups groups={[...groups.map((group) => group.heading === "Settings" ? { ...group, entries: [...group.entries, ...rows] } : group), { heading: "Sessions", entries: [sessions] }]} />;
};

/** The sessions page: `projections.search`'s rows on every environment, in the sidebar's order; one chosen opens in the focused pane. */
const SessionsPage = ({ query, close }: { readonly query: string; readonly close: PaletteProps["close"] }) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const rows = useObservable(useMemo(() => runtime.projections.search(query), [runtime, query]));
  const [, setLayout] = usePresentation("paneLayout");
  const entryOf = (row: SessionRow): Entry => {
    const environment = environments.find((view) => view.environmentId === row.environmentId);
    const name = environment?.name ?? THIS_MACHINE;
    return {
      value: `${row.environmentId}/${row.summary.id}`,
      name: row.summary.title,
      icon: MessageSquare,
      metadata: <SessionMetadata row={row} />,
      detail: name,
      swatch: <span role="img" aria-label={`${name} colour`} className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: environmentColour(environment?.colour ?? null) ?? "var(--cyan)" }} />,
      keys: [],
      offer: PRESENT,
      choose: () => close(() => setLayout((held) => showSession(held, held.focused, { environmentId: row.environmentId, sessionId: row.summary.id }))),
    };
  };
  return (
    <>
      <Command.Empty className="px-3 py-6 text-center text-sm text-ink-faint">No session matches that.</Command.Empty>
      <Groups groups={[{ heading: "Sessions", entries: rows.map(entryOf) }]} />
    </>
  );
};

/** A page's groups, each under its heading; a group with no entries is not drawn. */
const Groups = ({ groups }: { readonly groups: readonly EntryGroup[] }) =>
  groups
    .filter((group) => group.entries.length > 0)
    .map((group) => (
      <Command.Group key={group.heading} heading={group.heading}>
        {group.entries.map((entry) => (
          <PaletteEntry key={entry.value} entry={entry} />
        ))}
      </Command.Group>
    ));

/** The picker's keys, wired in the palette's region. */
const PickerKeys = ({ move, choose, leave, back }: { readonly move: (key: number) => void; readonly choose: () => void; readonly leave: () => void; readonly back: () => false | void }) => {
  useKeyAction("picker.move", move);
  useKeyAction("picker.choose", choose);
  useKeyAction("picker.leave", leave);
  useKeyAction("picker.back", back);
  return null;
};

/** An entry: its name, what is said beside it and its keys; dim with its reason under it while it cannot be done. */
const PaletteEntry = ({ entry }: { readonly entry: Entry }) => {
  const absent = entry.offer.status === "absent" ? entry.offer.message : undefined;
  const Icon = entry.icon;
  return (
    <Command.Item
      value={entry.value}
      disabled={absent !== undefined}
      onSelect={entry.choose}
      title={`${entry.name} — ${entry.keys.length > 0 ? entry.keys.join(" or ") : "Enter"}${absent !== undefined ? `: ${absent}` : ""}`}
      className="cursor-default select-none rounded-md text-sm data-[disabled=true]:text-ink-faint data-[selected=true]:bg-wash-strong"
    >
      <span className="flex w-full flex-col gap-0.5 px-2 py-1.5">
        <span className="flex w-full items-center gap-2">
          <Icon aria-hidden="true" data-measure="palette-row-icon" className="size-4 shrink-0" />
          <span className={`min-w-0 flex-1 truncate ${absent !== undefined ? "line-through" : ""}`}>{entry.name}</span>
          {entry.detail !== undefined && <span className="flex max-w-[35%] items-center gap-1 text-2xs text-ink-faint">{entry.swatch}<span className="truncate">{entry.detail}</span></span>}
          {entry.keys.map((key) => (
            <Kbd key={key} className="shrink-0">
              {key}
            </Kbd>
          ))}
        </span>
        {entry.metadata}
        {absent !== undefined && <span className="pl-6 text-2xs">{absent}</span>}
      </span>
    </Command.Item>
  );
};

/** Concept icons apply to both keyed actions and their slash-command routes. */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  "app.interrupt": CircleStop, "app.find": Search, "app.session.new": MessageSquare, "app.session.newInPane": MessageSquare,
  "app.sidebar.toggle": PanelLeft, "app.terminal.toggle": SquareTerminal, "app.browser.choose": Globe, "app.browser.toggle": Globe,
  "app.pane.splitRight": SquareSplitHorizontal, "app.pane.splitDown": SquareSplitVertical, "app.settings.toggle": Settings2, "app.runInfo.toggle": Info,
  "composer.send": SendHorizontal, "composer.paste": Paperclip, "composer.readNow": ArrowDownToLine, "composer.withdrawLast": ArrowUpFromLine,
  "command.model": Cpu, "command.mode": Shield, "command.attach": Paperclip, "command.fork": GitFork, "command.rewind": Undo2,
  "command.undo": Undo2, "command.check": ListChecks, "command.tasks": ListChecks, "command.search": Search,
  "command.terminal": SquareTerminal, "command.files": Folder, "command.documents": BookOpen, "command.diff": FileText,
};
const iconOf = (id: ActionId): LucideIcon => ICONS[id] ?? (isCommandId(id) ? Settings2 : Keyboard);

type Heading = "Session" | "Configure" | "Settings" | "Inspect";
/** Presentation groups preserve registry order within each group and retain every wired action. */
const headingOf = (action: ListedAction): Heading => {
  if (action.id === "app.settings.toggle" || action.id === "command.settings") return "Settings";
  if (/^(transcript\.find|app\.(find|runInfo\.)|command\.(diff|check|tasks|search|files|documents)$)/.test(action.id)) return "Inspect";
  if (/^(app\.(sidebar\.|browser\.choose)|command\.(model|mode|account|containment|handoff)$)/.test(action.id)) return "Configure";
  return "Session";
};

/** Age is measured on the owning environment's clock; worktree branches are recorded facts. */
const SessionMetadata = ({ row }: { readonly row: SessionRow }) => {
  const runtime = useRuntime();
  const { summary } = row;
  const at = summary.lastActivityAt ?? summary.createdAt;
  const minutes = Math.max(0, Math.floor((runtime.environmentNow(row.environmentId).getTime() - Date.parse(at)) / 60_000));
  const age = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  return <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-6 font-mono text-2xs text-ink-faint">
    <time dateTime={at} title={at}>{age}</time>
    <span className="min-w-0 max-w-full truncate" title={summary.workspace.path}>{summary.workspace.path}</span>
    {summary.workspace.kind === "worktree" && <span className="flex min-w-0 max-w-full items-center gap-1"><GitBranch aria-hidden="true" className="size-3 shrink-0" /><span className="truncate" title={summary.workspace.branch}>{summary.workspace.branch}</span></span>}
  </span>;
};

/**
 * The window under the command palette: `children`, inert while the palette
 * is open over it. Mod+K opens it, or closes it when it is open; closing it
 * gives the focus back to where it was, and a chosen entry is done there.
 */
export const CommandPalette = ({ children }: { readonly children: ReactNode }) => {
  const wired = useEveryWiredAction();
  // The actions it lists while it is open: those whose keys' condition holds as it opens, asked before it takes the focus.
  const [listed, setListed] = useState<ReadonlySet<ActionId> | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const then = useRef<(() => void) | undefined>(undefined);
  const close = useCallback((after?: () => void) => {
    then.current = after;
    setListed(null);
  }, []);
  useKeyAction("app.palette", () => {
    if (listed !== null) return close();
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setListed(new Set(wired.filter((action) => action.holds()).map((action) => action.id)));
  });
  // Once the window is no longer inert: the focus goes back, then what was chosen is done where it is.
  useLayoutEffect(() => {
    if (listed !== null) return;
    const after = then.current;
    then.current = undefined;
    returnTo.current?.focus();
    returnTo.current = null;
    after?.();
  }, [listed]);
  return (
    <>
      <div className="contents" inert={listed !== null}>
        {children}
      </div>
      {listed !== null && <Palette listed={listed} close={close} />}
    </>
  );
};

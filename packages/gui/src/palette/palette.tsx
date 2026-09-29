import type { SessionRow } from "@agent-harness/client-runtime";
import { ACTION_GROUPS, isCommandId, type ActionId, type ListedAction } from "@agent-harness/contracts";
import { Command } from "cmdk";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { keyLabel } from "../keys/chords.js";
import { KeyContext, useEveryWiredAction, useIsKeyOf, useKeyAction, useMacOS, type Offer, type WiredAction } from "../keys/key-dispatch.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The command palette (docs/specs/gui.md, "The window and the sidebar";
 * stories 4 and 9; #406), opened over the window by Mod+K (`app.palette`),
 * over cmdk. Its first page lists every action the window has wired
 * (`useEveryWiredAction`), in the shared list's groups and order, each with
 * its GUI keys in force, the slash commands the window wires last among
 * them; its last entry opens the sessions page, which finds a session on
 * every environment through `projections.search` and opens it in the
 * focused pane. Typing filters a page; choosing an entry closes the palette,
 * gives the focus back to where it was, and runs it there.
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

/** The palette's words for an action whose shared-list words are the terminal's: "Stop the run" is `app.interrupt`. */
const NAMES: Partial<Readonly<Record<ActionId, string>>> = { "app.interrupt": "Stop the run" };

/** An action the palette itself answers, which it does not list: its list's keys, and the key that opens it. */
const answeredByPalette = (action: ListedAction): boolean => action.context === "picker" || action.id === "app.palette";

const PRESENT: Offer = { status: "present" };

/** One entry of a page. */
interface Entry {
  /** cmdk's value for it: unique on its page. */
  readonly value: string;
  readonly name: string;
  /** What is said beside its name: a slash command's description, a session's environment. */
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

/** The keys the GUI column binds to `action` now: none written off. */
const keysInForce = (action: ListedAction): readonly string[] => (action.gui.status === "wired" && action.gui.off !== true ? action.gui.keys : []);

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-40 flex items-start justify-center bg-wash-strong px-4 pt-[12vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        // The window's keys would act on the window under it: only the one that closes it goes on to the window.
        if (!closes(event.nativeEvent)) event.stopPropagation();
      }}
    >
      <Command
        ref={root}
        label={LABELS[page]}
        shouldFilter={false}
        vimBindings={false}
        loop
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-line-strong bg-float text-ink"
      >
        <KeyContext context="picker" conditions={{ "picker.queryEmpty": () => query.length === 0 }}>
          <PickerKeys move={(key) => press(key === 0 ? "ArrowUp" : "ArrowDown")} choose={() => press("Enter")} leave={() => close()} back={back} />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={PLACEHOLDERS[page]}
            className="h-11 w-full border-b border-hairline bg-transparent px-4 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {/* A press on the list leaves the focus in the query, so what is typed after choosing a page, or a dim entry, filters. */}
          <Command.List
            onMouseDown={(event) => event.preventDefault()}
            className="max-h-96 overflow-y-auto p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-faint"
          >
            {page === "root" ? (
              <FirstPage listed={listed} query={query.trim()} close={close} toSessions={() => setPage("sessions")} />
            ) : (
              <SessionsPage query={query.trim()} close={close} />
            )}
          </Command.List>
        </KeyContext>
      </Command>
    </div>
  );
};

/**
 * The first page: the listed actions the query matches, in the shared list's
 * groups and order, and last, whatever is typed, the way to the sessions
 * page, so a session's title typed here is one Enter from its page.
 */
const FirstPage = ({ listed, query, close, toSessions }: PaletteProps & { readonly query: string; readonly toSessions: () => void }) => {
  const macOS = useMacOS();
  const wired = useEveryWiredAction();
  const entryOf = (action: ListedAction, wiredAction: WiredAction): Entry => {
    const command = isCommandId(action.id);
    return {
      value: action.id,
      name: NAMES[action.id] ?? (command ? `/${action.id.slice("command.".length)}` : action.description),
      ...(command && { detail: action.description }),
      keys: keysInForce(action).map((key) => keyLabel(key, macOS)),
      offer: wiredAction.offer,
      choose: () => close(wiredAction.run),
    };
  };
  const groups = ACTION_GROUPS.map(
    (group): EntryGroup => ({
      heading: group.title,
      entries: (group.actions as readonly ListedAction[])
        .flatMap((action) => {
          const wiredAction = wired.findLast((candidate) => candidate.id === action.id);
          return wiredAction === undefined || !listed.has(action.id) || answeredByPalette(action) ? [] : [entryOf(action, wiredAction)];
        })
        .filter((entry) => matches(entry, query)),
    }),
  );
  const sessions: Entry = {
    value: "sessions",
    name: query === "" ? "Sessions on every environment…" : `Sessions on every environment matching “${query}”`,
    keys: [],
    offer: PRESENT,
    choose: toSessions,
  };
  return <Groups groups={[...groups, { heading: "Sessions", entries: [sessions] }]} />;
};

/** The sessions page: `projections.search`'s rows on every environment, in the sidebar's order; one chosen opens in the focused pane. */
const SessionsPage = ({ query, close }: { readonly query: string; readonly close: PaletteProps["close"] }) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const rows = useObservable(useMemo(() => runtime.projections.search(query), [runtime, query]));
  const [, setLayout] = usePresentation("paneLayout");
  const entryOf = (row: SessionRow): Entry => ({
    value: `${row.environmentId}/${row.summary.id}`,
    name: row.summary.title,
    detail: environments.find((environment) => environment.environmentId === row.environmentId)?.name ?? THIS_MACHINE,
    keys: [],
    offer: PRESENT,
    choose: () => close(() => setLayout({ session: { environmentId: row.environmentId, sessionId: row.summary.id } })),
  });
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
  return (
    <Command.Item
      value={entry.value}
      disabled={absent !== undefined}
      onSelect={entry.choose}
      className="flex cursor-default select-none flex-col gap-0.5 rounded-sm px-2 py-1.5 text-sm data-[disabled=true]:text-ink-faint data-[selected=true]:bg-wash-strong"
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {entry.detail !== undefined && <span className="shrink-0 text-xs text-ink-faint">{entry.detail}</span>}
        {entry.keys.map((key) => (
          <kbd key={key} className="shrink-0 rounded border border-line px-1 font-mono text-xs text-ink-muted">
            {key}
          </kbd>
        ))}
      </span>
      {absent !== undefined && <span className="text-xs">{absent}</span>}
    </Command.Item>
  );
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

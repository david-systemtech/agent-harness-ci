import { keepsFold, rowKey, sessionHeadings, type DropTarget, type HeadingRow, type SessionHeading, type SessionRow } from "@agent-harness/client-runtime";
import { useMemo, useRef, type ReactNode } from "react";
import { FolderGit2, PanelLeftClose, Plug, Plus, RotateCcw, Search } from "lucide-react";
import { useFirstKey } from "../keys/key-dispatch.js";
import { NewSessionButton } from "../new-session/control.js";
import { useOpenPairing } from "../connections/pairing.js";
import { focusedPane } from "../grid/layout.js";
import { useOpenInPane } from "../session/pane-line.js";
import { classes } from "../ui/classes.js";
import { Button, IconButton, Input, Tooltip } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { ScheduledStrip } from "../routines/scheduled-strip.js";
import { SidebarDialogs } from "./dialogs.js";
import { useDropTarget } from "./drag.js";
import { EnvironmentSection, FoldingSection } from "./headings.js";
import { OrganiseLine, OrganiseProvider, useOrganise } from "./organise.js";
import { SessionRowView } from "./row.js";
import { useDraggedRow, useFilterFocus, useSidebarFilter, useSidebarSearchShown } from "./window-sidebar.js";
import { SidebarNewGroup } from "./new-group.js";

/**
 * The sidebar (docs/specs/gui.md, "The window and the sidebar"; #397, #398):
 * every environment's sessions at once, drawn from `projections.sessionList`
 * and `projections.environments` under the headings the terminal UI's rail
 * draws (the client runtime's `sessionHeadings`), each row opening its
 * session in the focused pane. Typing in its filter narrows it to
 * `projections.search`'s rows, in the sidebar's order, with no headings;
 * clearing it brings the headings back. A switch heads the active sessions
 * by repository instead of by group (#422): one heading per repository
 * across environments, then each environment's sessions with no identity.
 * The switch and the folds are presentation (`sidebarView`,
 * `collapsedHeadings`); what is typed in the filter lasts while the window
 * does, the sidebar hidden and shown again or not (`window-sidebar.tsx`).
 * Organising is one gesture (#398): a row's or a merged group's context
 * menu, or a drag, each command through the outbox once (`organise.tsx`);
 * while a session is dragged and nothing is pinned, the pinned block stands
 * empty at the top to be dropped on. At its foot, the line saying what an
 * organising command did not do, Restore, and pairing with another
 * environment.
 */
export const Sidebar = () => (
  <OrganiseProvider>
    <Headings />
  </OrganiseProvider>
);

const Headings = () => {
  const phone = usePhoneFrame();
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const list = useObservable(runtime.projections.sessionList);
  const [folded, setFolded] = usePresentation("collapsedHeadings");
  const [by, setBy] = usePresentation("sidebarView");
  const [layout] = usePresentation("paneLayout");
  const [, setSidebarShown] = usePresentation("sidebarShown");
  const sidebarKeys = useFirstKey("app.sidebar.toggle");
  const newSessionKeys = useFirstKey("app.session.new");
  const openInPane = useOpenInPane();
  const openPairing = useOpenPairing();
  const organise = useOrganise();
  const [filter, setFilter] = useSidebarFilter();
  const searchShown = useSidebarSearchShown();
  const field = useRef<HTMLInputElement>(null);
  useFilterFocus(field);
  const [dragged] = useDraggedRow();
  const query = filter.trim();

  const headings = useMemo(
    () => sessionHeadings({ list, environments, folded, matches: null, by, now: (environmentId) => runtime.environmentNow(environmentId) }),
    [runtime, list, environments, folded, by],
  );

  /** Folds or opens a heading; the folds of groups no longer listed are dropped as the choice is kept. */
  const fold = (key: string, shut: boolean) =>
    setFolded((held) => {
      const keep = keepsFold(runtime.projections.sessionList.read());
      return { ...Object.fromEntries(Object.entries(held).filter(([heading]) => heading === key || keep(heading))), [key]: shut };
    });

  const views = new Map(environments.map((view) => [view.environmentId, view]));
  const shown = focusedPane(layout).session;
  /** Each row, taking a session dropped on it at its place in its heading's block, or refusing it in the filtered list (null). */
  const rows = (lines: readonly HeadingRow[], heading: SessionHeading | null) =>
    lines.map((line) => (
      <SessionRowView
        key={line.key}
        line={line}
        environment={views.get(line.row.environmentId)}
        current={shown?.environmentId === line.row.environmentId && shown.sessionId === line.row.summary.id}
        drop={heading === null ? { kind: "filtered" } : { kind: "row", heading, at: heading.block.rows.findIndex((held) => rowKey(held) === line.key) }}
        open={() => { openInPane(line.row.environmentId, line.row.summary.id); if (phone.narrow) phone.showDrawer(false); }}
      />
    ));

  return (
    <nav aria-label="Sessions" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div data-sidebar-caption className="chrome-label flex h-8 shrink-0 items-center justify-between px-2 text-ink-muted">
        <span>Sessions</span>
        <IconButton label={phone.narrow ? "Close sessions" : "Hide sidebar"} {...(sidebarKeys !== undefined && { keys: sidebarKeys })} size="icon-xs" onClick={() => phone.narrow ? phone.showDrawer(false) : setSidebarShown(false)}><PanelLeftClose aria-hidden="true" /></IconButton>
      </div>
      <div className="shrink-0 p-2">
        <Tooltip content={["New session", newSessionKeys].filter(Boolean).join(" · ")}>
          <NewSessionButton control={{ environmentId: null }} label="New session" variant="default" size="sm" className="h-auto min-h-7 w-full flex-wrap justify-start py-0">
            <span className="inline-flex shrink-0 items-center gap-1"><Plus aria-hidden="true" data-icon="inline-start" /><span>New session</span></span>
            {newSessionKeys !== undefined && <kbd className="ml-auto shrink-0 font-mono text-2xs">{newSessionKeys}</kbd>}
          </NewSessionButton>
        </Tooltip>
      </div>
      {!phone.narrow && <ScheduledStrip />}
      <div className="flex shrink-0 items-center gap-1 px-1.5 pt-2 pb-1.5">
        {(phone.narrow || list.rows.length > 8 || searchShown || filter !== "") && (
          <div className="phone-frame-filter relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1.5 left-2 size-3 text-ink-faint" />
            <Input ref={field} type="search" aria-label="Filter the sessions" title="Filter the sessions" placeholder="Filter" className="h-6 pl-[26px] text-xs" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </div>
        )}
        <SidebarNewGroup environmentId={focusedPane(layout).session?.environmentId ?? environments[0]?.environmentId} />
        <IconButton label="By repository" size="icon-xs" role="switch" aria-checked={by === "repositories"} onClick={() => setBy(by === "repositories" ? "groups" : "repositories")} className={by === "repositories" ? "bg-wash-strong text-beam-text" : undefined}>
          <FolderGit2 aria-hidden="true" />
        </IconButton>
      </div>
      <div data-sidebar-scroll className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2">
        {phone.narrow && <ScheduledStrip />}
        {query === "" ? (
          <>
            {dragged !== null && !headings.some((heading) => heading.kind === "pinned") && <EmptyPinned />}
            {headings.map((heading) =>
              heading.kind === "environment" ? (
                <EnvironmentSection key={heading.key} heading={heading} rows={rows} />
              ) : (
                <FoldingSection key={heading.key} heading={heading} fold={fold} rows={rows} />
              ),
            )}
          </>
        ) : (
          <Matches query={query} rows={(lines) => rows(lines, null)} />
        )}
      </div>
      <div data-sidebar-footer className="flex shrink-0 flex-col border-t border-hairline">
        <OrganiseLine />
        <Tooltip content="Restore a deleted session…">
          <Button className="h-auto w-full justify-start rounded-none px-2.5 py-2 text-left text-2xs whitespace-normal text-ink-muted hover:bg-wash" onClick={() => organise.open({ kind: "restore" })}><RotateCcw aria-hidden="true" className="size-3" /><span className="min-w-0">Restore a deleted session…</span></Button>
        </Tooltip>
        <Tooltip content="Pair with an environment…">
          <Button className="h-auto w-full justify-start rounded-none px-2.5 py-2 text-left text-2xs whitespace-normal text-ink-muted hover:bg-wash" onClick={() => openPairing()}><Plug aria-hidden="true" className="size-3" /><span className="min-w-0">Pair with an environment…</span></Button>
        </Tooltip>
      </div>
      <SidebarDialogs />
    </nav>
  );
};

/** The pinned block while nothing is pinned, drawn only while a session is dragged: dropped on, the session is pinned. */
const EmptyPinned = () => {
  const target = useDropTarget(ONTO_THE_EMPTY_BLOCK);
  return (
    <p {...target.handlers} className={classes("rounded-sm border border-dashed border-line px-2 py-1.5 text-xs text-ink-muted", target.over && "bg-wash-strong")}>
      Pinned: drop here to pin it.
    </p>
  );
};

const ONTO_THE_EMPTY_BLOCK: DropTarget = { kind: "pinned" };

/**
 * The sidebar narrowed by its filter: `projections.search`'s rows in its
 * order (the sidebar's: pinned, active, snoozed, settled, archived), each
 * drawn as it is under its heading, whatever the folds. A drop here is
 * refused: the rows a move goes between may be hidden.
 */
const Matches = ({ query, rows }: { readonly query: string; rows(lines: readonly HeadingRow[]): ReactNode }) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const list = useObservable(runtime.projections.sessionList);
  const found = useObservable(useMemo(() => runtime.projections.search(query), [runtime, query]));
  // Each row as the headings draw it, every heading open: its activity, its marker, a snoozed one's wake time, dim or not.
  const lineOf = useMemo(() => {
    const all = sessionHeadings({ list, environments, folded: {}, matches: null, open: true, now: (environmentId) => runtime.environmentNow(environmentId) });
    return new Map(all.flatMap((heading) => heading.rows).map((line) => [line.key, line]));
  }, [runtime, list, environments]);
  const lines = found.flatMap((row: SessionRow) => lineOf.get(rowKey(row)) ?? []);
  return lines.length === 0 ? (
    <p className="text-sm text-ink-faint">No session matches “{query}”.</p>
  ) : (
    <ul aria-label={`Sessions matching “${query}”`} className="flex flex-col">
      {rows(lines)}
    </ul>
  );
};

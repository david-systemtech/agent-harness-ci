import { ChevronRight, PanelLeft, Search, Settings } from "lucide-react";
import { useMemo } from "react";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { focusedPane } from "../grid/layout.js";
import { useEveryWiredAction, useFirstKey } from "../keys/key-dispatch.js";
import { ParkedAsksButton } from "../parked-asks/parked-asks.js";
import type { PaneSession } from "../presentation.js";
import { useSettings } from "../settings/settings-window.js";
import { SetupLine } from "../setup/setup-line.js";
import { Button, IconButton, Tooltip } from "../ui/index.js";
import { RestartToUpdate } from "../updates/restart-to-update.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { SessionDrawerTrigger, usePhoneFrame } from "./phone-frame.js";
import { HeaderMenu } from "./header-menu.js";
import { nativeFrame, useWindowFrame, WindowControls } from "./window-controls.js";
import { ThemeToggle } from "./theme-toggle.js";

/** The focused session's live summary, with the list's pending rename reflected immediately. */
const SessionBreadcrumb = ({ session }: { readonly session: PaneSession }) => {
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const list = useObservable(runtime.projections.sessionList);
  const projection = useObservable(useMemo(() => runtime.projections.session(session.environmentId, session.sessionId), [runtime, session.environmentId, session.sessionId]));
  const summary = list.rows.find((row) => row.environmentId === session.environmentId && row.summary.id === session.sessionId.toLowerCase())?.summary ?? projection.summary;
  const environment = environments.find((view) => view.environmentId === session.environmentId);
  const path = summary?.workspace.path;
  const { narrow } = usePhoneFrame();
  if (narrow) return <span data-header-session-title title={summary?.title ?? undefined} className="min-w-0 flex-1 truncate text-sm text-ink">{summary?.title ?? "Session"}</span>;
  const workspace = path?.split(/[/\\]/).filter(Boolean).at(-1) ?? path ?? "No workspace";
  return <>
    {environment !== undefined && <span title={environment.name ?? undefined} className="flex min-w-0 max-w-40 shrink items-center gap-1 rounded-md border border-hairline px-1.5 text-xs text-ink-muted">
      <EnvironmentGlyph view={environment} /><span className="truncate">{environment.name ?? "This machine"}</span>
    </span>}
    <span title={path ?? undefined} className="min-w-0 max-w-56 truncate text-xs text-ink-muted">{workspace}</span>
    <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />
    <span data-header-session-title title={summary?.title ?? undefined} className="min-w-12 flex-1 truncate text-xs text-ink-muted">{summary?.title ?? "Session"}</span>
  </>;
};

/** One 44px line of window context and actions (look §9.1); the title yields space first. */
export const Header = ({ onPair }: { readonly onPair?: () => void }) => {
  const [sidebarShown, setSidebarShown] = usePresentation("sidebarShown");
  const [layout] = usePresentation("paneLayout");
  const pane = focusedPane(layout);
  const sidebarKeys = useFirstKey("app.sidebar.toggle");
  const searchKeys = useFirstKey("app.palette");
  const settingsKeys = useFirstKey("app.settings.toggle");
  const actions = useEveryWiredAction();
  const settings = useSettings();
  const frame = useWindowFrame();
  const { narrow } = usePhoneFrame();
  if (narrow) return <header data-window-header className="phone-frame-header flex min-w-0 shrink-0 items-center gap-1 border-b border-hairline bg-abyss px-2">
    <SessionDrawerTrigger asChild><IconButton label="Show sessions" {...(sidebarKeys !== undefined && { keys: sidebarKeys })}><PanelLeft aria-hidden="true" /></IconButton></SessionDrawerTrigger>
    <div className="flex min-w-0 flex-1">{pane.session !== null ? <SessionBreadcrumb session={pane.session} /> : <span className="truncate text-sm text-ink-muted">{pane.newSession !== undefined ? "New session" : "No session"}</span>}</div>
    <ParkedAsksButton />
    <HeaderMenu {...(onPair !== undefined && { onPair })} />
    <IconButton label="Settings" {...(settingsKeys !== undefined && { keys: settingsKeys })} onClick={() => settings.open()}><Settings aria-hidden="true" /></IconButton>
  </header>;
  return (
    <header data-window-header {...nativeFrame(frame)} className="flex h-[44px] min-w-0 shrink-0 items-center gap-1 whitespace-nowrap border-b border-hairline bg-abyss px-2">
      {!sidebarShown && <IconButton label="Show sidebar" {...(sidebarKeys !== undefined && { keys: sidebarKeys })} size="icon-xs" onClick={() => setSidebarShown(true)}><PanelLeft aria-hidden="true" /></IconButton>}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {pane.session !== null ? <SessionBreadcrumb session={pane.session} /> : <>
          <span className="min-w-0 truncate text-xs text-ink-faint">No workspace</span>
          <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />
          <span className="min-w-0 truncate text-xs text-ink-muted">{pane.newSession !== undefined ? "New session" : "No session"}</span>
        </>}
      </div>
      <Tooltip content="Search sessions and commands" keys={searchKeys}>
        <Button aria-label="Search sessions and commands" size="xs" className="hidden min-w-0 max-w-[448px] flex-1 justify-start gap-2 border border-hairline-strong bg-wash text-ink-faint min-[1024px]:inline-flex" onClick={() => actions.find((action) => action.id === "app.palette")?.run()}>
          <Search aria-hidden="true" /><span className="min-w-0 flex-1 truncate">Search sessions and commands</span><kbd className="shrink-0">{searchKeys}</kbd>
        </Button>
      </Tooltip>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RestartToUpdate />
        <SetupLine />
        <ParkedAsksButton />
        <HeaderMenu />
        <IconButton label="Settings" {...(settingsKeys !== undefined && { keys: settingsKeys })} onClick={() => settings.open()}><Settings aria-hidden="true" /></IconButton>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-hairline" />
        <ThemeToggle />
        <WindowControls state={frame} />
      </div>
    </header>
  );
};

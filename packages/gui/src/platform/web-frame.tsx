import { blockWords, type EnvironmentView, type PairingFailure } from "@agent-harness/client-runtime";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Settings, Plus, Link } from "lucide-react";
import { BrowserPanesProvider } from "../browser/browser-panes.js";
import { TerminalPanesProvider } from "../terminal/terminal-panes.js";
import { LimitedAccess } from "../connections/limited-access.js";
import { PairingForm, PairingRefusal } from "../connections/pairing.js";
import { remedyOf } from "../connections/words.js";
import { PaneGridProvider, usePaneGrid } from "../grid/grid.js";
import { focusedPane, showSession } from "../grid/layout.js";
import { PaneGrid } from "../grid/pane-grid.js";
import { Header } from "../frame/header.js";
import { PhoneFrameProvider, SessionDrawer, usePhoneFrame } from "../frame/phone-frame.js";
import { useKeyAction } from "../keys/key-dispatch.js";
import { NewSessionSurfaces } from "../new-session/surfaces.js";
import { PaneLines } from "../session/pane-line.js";
import { ChecklistView } from "../setup/checklist-view.js";
import { useChecklist } from "../setup/checklist-window.js";
import { SettingsView } from "../settings/settings-view.js";
import { useSettings } from "../settings/settings-window.js";
import { WindowNotices } from "../notices/window-notices.js";
import { Button } from "../ui/button.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import { sessionLink, type BrowserRoute } from "./browser-boot.js";
import type { BrowserPlatform } from "./browser-platform.js";
import { usePhoneViewport } from "../composer/phone-viewport.js";
import { WebRegisteredSurfaces } from "./web-registrations.js";
import "./web-frame.css";

export interface WebFrameProps { readonly platform: BrowserPlatform; readonly route: BrowserRoute }

/** Shared browser bounds: a keyboard can shrink this without resizing the layout viewport. */
export const WebViewport = ({ children, narrow = false, connection }: { readonly children: ReactNode; readonly narrow?: boolean; readonly connection?: EnvironmentView | undefined }) => {
  const frame = useRef<HTMLDivElement>(null);
  usePhoneViewport(frame);
  return <div ref={frame} data-web-client data-web-grant={connection ? "" : undefined} data-phase={connection?.phase} data-ceiling={connection?.ceiling ?? undefined} data-scopes={connection?.scopes.join(", ")} data-phone-frame={narrow ? "" : undefined} className="flex h-dvh min-w-0 flex-col bg-abyss text-ink">{children}</div>;
};
/**
 * A blocked connection's line in its block's words (#1776). Where pairing
 * again is the cure, it carries Pair again, which opens the pairing form for
 * that connection: a phone's header has no Pair button of its own.
 */
const BlockedLine = ({ view, onPair }: { readonly view: EnvironmentView; readonly onPair: () => void }) => {
  const rePair = remedyOf(view) === "re-pair";
  return <div role="status" data-connection-blocked className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
    <p className="min-w-0 flex-1 basis-48">{blockWords(view)}{rePair && " Make a new code on a trusted client first."}</p>
    {rePair && <Button variant="default" onClick={onPair}><Link aria-hidden="true" className="size-4" />Pair again</Button>}
  </div>;
};
/** The first browser slice uses the same session components and environment-owned work. */
export const WebFrame = (props: WebFrameProps) => (
  <PhoneFrameProvider><BrowserPanesProvider><TerminalPanesProvider><PaneGridProvider><NewSessionSurfaces><PaneLines>
    <WebConversation {...props} />
  </PaneLines></NewSessionSurfaces></PaneGridProvider></TerminalPanesProvider></BrowserPanesProvider></PhoneFrameProvider>
);

const WebConversation = ({ platform, route }: WebFrameProps) => {
  const phone = usePhoneFrame();
  useKeyAction("app.sidebar.toggle", () => phone.showDrawer(!phone.drawerShown));
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const sessions = useObservable(runtime.projections.sessionList);
  const persistence = useObservable(platform.persistence);
  const [layout, setLayout] = usePresentation("paneLayout");
  const pane = focusedPane(layout);
  const grid = usePaneGrid();
  const settings = useSettings();
  const checklist = useChecklist();
  const [line, setLine] = useState<string>();
  /** A handed link's refusal, said as the pairing form says one (setup-copy.md §4.2). */
  const [refusal, setRefusal] = useState<PairingFailure>();
  /** The pairing form, shown in place of the conversation; `rePair` names the connection it replaces. */
  const [pairing, setPairing] = useState<{ readonly rePair?: string }>();
  const [handedLink, setHandedLink] = useState<string>();
  const paired = environments.filter(env => env.kind === "paired");
  const selected = paired.find(env => env.environmentId === pane.session?.environmentId) ?? paired[0];
  const consumed = useRef(false);
  useEffect(() => {
    const input = route.pairing;
    if (consumed.current || input === undefined) return;
    consumed.current = true;
    setLine("Pairing…");
    void runtime.connections.add(input).then(outcome => {
      if (outcome.status === "re-pair-offered") {
        setHandedLink("link" in input ? input.link : `${input.address}/pair#${input.code}`);
        setPairing({});
      }
      if (outcome.status === "failed") setRefusal(outcome.failure);
      setLine(outcome.status === "re-pair-offered" ? "Already paired. Confirm this link to replace the connection deliberately." : undefined);
    }, () => setLine("Pairing failed. Make a new code and try again."));
  }, [runtime, route]);
  const openedRoute = useRef(false);
  useEffect(() => {
    if (openedRoute.current || !route.session || !sessions.rows.some(row => row.environmentId === route.session?.environmentId && row.summary.id === route.session.sessionId)) return;
    openedRoute.current = true;
    const session = route.session;
    setLayout(held => showSession(held, held.focused, session));
  }, [route, sessions.rows, setLayout]);
  const open = (key: string) => {
    const row = sessions.rows.find(row => `${row.environmentId}/${row.summary.id}` === key);
    if (!row) return;
    const session = { environmentId: row.environmentId, sessionId: row.summary.id };
    setLayout(held => showSession(held, held.focused, session));
    history.replaceState(null, "", sessionLink(session));
  };
  useEffect(() => { if (pane.session) history.replaceState(null, "", sessionLink(pane.session)); }, [pane.session]);
  if (checklist.shown) return <ChecklistView />;
  return <WebViewport narrow={phone.narrow} connection={selected}>
    {phone.narrow ? <Header onPair={() => setPairing(held => held ? undefined : {})} /> : <header className="flex min-w-0 shrink-0 items-center gap-1 border-b border-hairline p-2">
      <label className="sr-only" htmlFor="web-session">Sessions</label>
      <select id="web-session" aria-label="Sessions" className="min-w-0 flex-1 rounded-md border border-hairline bg-panel px-2 text-ink" value={pane.session ? `${pane.session.environmentId}/${pane.session.sessionId}` : ""} onChange={event => open(event.target.value)}>
        <option value="">Open a session</option>
        {sessions.rows.map(row => <option key={`${row.environmentId}/${row.summary.id}`} value={`${row.environmentId}/${row.summary.id}`}>{row.summary.title ?? "Untitled session"}</option>)}
      </select>
      <Button title="New session" aria-label="New session" onClick={() => grid.newSession(null)}><Plus aria-hidden="true" className="size-4" /></Button>
      <Button title="Pair with an environment" aria-label="Pair with an environment" onClick={() => setPairing(held => held ? undefined : {})}><Link aria-hidden="true" className="size-4" /></Button>
      <Button title="Settings" aria-label="Settings" onClick={() => settings.open()}><Settings aria-hidden="true" className="size-4" /></Button>
    </header>}
    {persistence === "visit-only" && <p role="status" className="shrink-0 border-b border-hairline bg-panel px-3 py-2 text-sm">Storage is unavailable. Pair for this visit; this connection will be forgotten when you close or reload.</p>}
    {selected && <LimitedAccess view={selected} />}
    {selected?.phase === "blocked" && <BlockedLine view={selected} onPair={() => setPairing({ rePair: selected.environmentId })} />}
    {line && <p role="status" className="shrink-0 px-3 py-2 text-sm">{line}</p>}
    {refusal && <div className="shrink-0 px-3 py-2"><PairingRefusal line={refusal.message} details={refusal.details ?? []} /></div>}
    <WebRegisteredSurfaces />
    {(paired.length === 0 || pairing !== undefined) ? <main className="min-h-0 flex-1 overflow-y-auto p-4"><h1 className="mb-3 text-lg">Pair with this environment</h1><p className="mb-4 text-sm text-ink-muted">Open a Phone link or scan its QR with your camera. You can also paste a link or enter the HTTPS address and code.</p><PairingForm link={handedLink} rePair={pairing?.rePair} onPaired={() => { setPairing(undefined); setHandedLink(undefined); setLine(undefined); setRefusal(undefined); }} toBrowserOrigins={(environmentId) => settings.open("environments.machines", environmentId, "browser-origins")} /></main> : <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <WindowNotices />
      <PaneGrid />
    </main>}
    <SessionDrawer />
    {settings.shown && <SettingsView />}
  </WebViewport>;
};

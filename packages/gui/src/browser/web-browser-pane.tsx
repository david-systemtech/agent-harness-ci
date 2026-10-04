import { Globe, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useMemo, useState } from "react";
import { focusedPane } from "../grid/layout.js";
import { openBrowserPage } from "../platform/web-browser.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, Input } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

/** Browser-tab replacement for the native dock; automation still belongs to the environment. */
export const WebBrowserPane = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string }) => {
  const runtime = useRuntime();
  const browsers = useObservable(useMemo(() => runtime.projections.browsers(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const session = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const environments = useObservable(runtime.projections.environments);
  const environment = environments.find(view => view.environmentId === environmentId);
  const offer = runtime.capability(environmentId, "sessions.setBrowser");
  const [busy, setBusy] = useState(false);
  const [line, say] = useState<string>();
  const [address, setAddress] = useState("");
  const [pageError, setPageError] = useState<string>();
  const choose = async (index: number) => {
    const row = browsers.rows[index];
    if (!row || row.unavailable || busy || offer.status === "absent") return;
    setBusy(true);
    try {
      const answer = await runtime.commands.dispatch(environmentId, "sessions.setBrowser", { sessionId, browser: row.value });
      say(answer.ok ? `Browser set to ${row.label} for the next run.` : `Browser not changed: ${answer.error.message}`);
    } catch { say("Browser not changed. Check the connection and try again."); }
    finally { setBusy(false); }
  };
  const run = session.runs.at(-1);
  const resolution = run && session.browserResolutions[run.runId];
  return <section data-web-browser className="flex min-w-0 flex-col gap-4 text-base [overflow-wrap:anywhere]">
    <form aria-label="Open a page" className="flex min-w-0 flex-col gap-2" onSubmit={event => {
      event.preventDefault();
      try { openBrowserPage(address); setPageError(undefined); }
      catch { setPageError("Could not open the page. Enter an HTTP or HTTPS address without credentials and allow new tabs."); }
    }}>
      <label className="font-medium" htmlFor={`page-${sessionId}`}>Page address</label>
      <Input id={`page-${sessionId}`} aria-label="Page address" autoCapitalize="none" autoCorrect="off" inputMode="url" value={address} onChange={event => setAddress(event.target.value)} className="h-11 min-w-0 text-[max(16px,1em)] md:text-[max(16px,1em)]" placeholder="https://example.org" />
      <Button type="submit" title="Open page · Enter · Opens a separate tab" variant="outline" className="h-11 self-start" disabled={!address.trim()}><Globe aria-hidden="true" />Open page</Button>
      {pageError && <p role="alert" className="text-signal">{pageError}</p>}
      <p className="text-ink-muted">Opens a separate browser tab. This page is not the environment's automation browser.</p>
    </form>
    <div className="flex min-w-0 flex-col gap-2">
      <label className="font-medium" htmlFor={`driver-${sessionId}`}>Browser for the next run</label>
      <select id={`driver-${sessionId}`} aria-label="Browser for the next run" className="h-11 min-w-0 w-full rounded-lg border border-hairline bg-panel px-2 text-[max(16px,1em)] text-ink" disabled={busy || offer.status === "absent"} value={Math.max(0, browsers.rows.findIndex(row => row.selected))} onChange={event => { void choose(Number(event.target.value)); }}>
        {browsers.rows.map((row, index) => <option key={JSON.stringify(row.value)} value={index} disabled={row.unavailable !== null}>{row.label}</option>)}
      </select>
      {offer.status === "absent" && <p role="status">{offer.message} Re-pair deliberately with a sessions:write grant to change the browser.</p>}
      {environment?.phase !== "ready" && <p role="status">Cached browser status. Reconnect to the environment before requesting automation.</p>}
      {resolution && <p role="status">{run.state === "running" ? "This run" : "Last run"}: {resolution.message} Changing the browser applies to the next run.</p>}
      {line && <p role="status">{line}</p>}
      <ul aria-label="Environment browser availability" className="flex flex-col gap-3">
        {browsers.rows.map(row => <li key={JSON.stringify(row.value)} className="rounded-lg border border-hairline bg-panel p-3">
          <h3 className="font-medium">{row.label}{row.selected ? " · Selected" : ""}</h3>
          <p className="text-ink-muted">{row.note}</p>
          {row.unavailable && <p className="text-ink-muted">{row.unavailable.message}{row.value?.kind === "headless" ? " Ask an environment administrator to configure and allow its headless browser in Settings → Browser." : ""}</p>}
        </li>)}
      </ul>
    </div>
    <p className="text-ink-muted">Automation uses the selected environment driver through the session's ordinary browser tools and permission checks. Ask the session to read, click or type on the page.</p>
    <p className="text-ink-muted">A phone cannot host the desktop Chrome extension or a local relay environment. Pair Chrome on the environment's machine with a trusted desktop client; existing paired Chrome availability is shown above.</p>
  </section>;
};

/** P01's web slot keeps startup and the native dock untouched. */
export const WebBrowserSurface = () => {
  const [layout] = usePresentation("paneLayout");
  const { session } = focusedPane(layout);
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  if (!session || settings.shown) return null;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button title="Environment browser · Enter / Space" className="h-11 shrink-0 self-start px-3"><Globe aria-hidden="true" />Environment browser</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/40" />
      <Dialog.Content aria-describedby={undefined} className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] min-w-0 flex-col rounded-t-xl border border-hairline bg-float p-4 text-ink outline-none sm:left-1/2 sm:w-[min(480px,85%)] sm:-translate-x-1/2">
        <header className="mb-3 flex shrink-0 items-center justify-between gap-2">
          <Dialog.Title className="text-base font-semibold">Environment browser</Dialog.Title>
          <Dialog.Close asChild><Button title="Close browser · Escape" aria-label="Close browser" className="h-11 w-11"><X aria-hidden="true" /></Button></Dialog.Close>
        </header>
        <div className="min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]"><WebBrowserPane key={`${session.environmentId}/${session.sessionId}`} {...session} /></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
};

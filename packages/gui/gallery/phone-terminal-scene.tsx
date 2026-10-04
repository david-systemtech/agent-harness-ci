import { useEffect, useState } from "react";
import { useObservable, useRuntime } from "../src/window-context.js";
import { TerminalPane } from "../src/terminal/terminal-pane.js";
import { TerminalPanesProvider } from "../src/terminal/terminal-panes.js";
import { WebViewport } from "../src/platform/web-frame.js";

/** The terminal leaf in the phone sheet on the browser runtime; no desktop shell. */
export const PhoneTerminalScene = () => {
  const [fontReady, setFontReady] = useState(document.fonts === undefined);
  useEffect(() => {
    const fonts = document.fonts;
    if (fonts === undefined) return;
    let mounted = true;
    // xterm measures cells on open; load its face before that first measurement.
    void fonts.load('12px "JetBrains Mono Variable"').then(() => fonts.ready).then(() => {
      if (mounted) setFontReady(true);
    });
    return () => { mounted = false; };
  }, []);
  const runtime = useRuntime();
  const environments = useObservable(runtime.projections.environments);
  const sessions = useObservable(runtime.projections.sessionList);
  const environment = environments[0];
  const session = sessions.rows[0];
  return <WebViewport>
    <h1 className="shrink-0 px-4 py-3 text-base font-semibold">Environment terminal</h1>
    <p className="shrink-0 px-4 pb-3 text-sm text-ink-muted">Hide the sheet to leave this terminal running.</p>
    <aside aria-label="Terminal sheet" style={{ maxWidth: 480 }} className="ml-auto flex min-h-0 w-[min(480px,85%)] flex-1 flex-col rounded-l-lg border border-hairline bg-panel">
      <h2 className="shrink-0 border-b border-hairline px-3 py-2 text-sm font-semibold">Terminal · desk</h2>
      {fontReady && environment && session && <TerminalPanesProvider><section aria-label="Terminal" className="flex min-h-0 flex-1 flex-col">
        <TerminalPane environmentId={environment.environmentId} sessionId={session.summary.id} onScreen />
      </section></TerminalPanesProvider>}
    </aside>
  </WebViewport>;
};

export const phoneTerminalGeometry = [
  { selector: '[data-web-client]', contentFits: true },
  { selector: '[aria-label="Terminal sheet"]', contentFits: true, maxWidth: 480 },
  { selector: '[aria-label="Terminal keys"] button', minimumHeight: 44, minimumWidth: 44, renderedOnly: true, visibleWithin: '[aria-label="Terminal sheet"]' },
  { selector: '[aria-label="Terminal screen"]', visibleWithin: '[aria-label="Terminal sheet"]' },
];

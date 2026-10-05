import { PRODUCT_NAME, type SessionBrowser } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { usePaneLine } from "../session/pane-line.js";
import { useObservable, useRuntime } from "../window-context.js";
import { BrowserChoiceMenu, BrowserChoiceSubmenu } from "./choice-menu.js";

/** The session field changes through its command; a running browser remains the run's resolution. */
export const SessionBrowserPicker = ({ environmentId, sessionId, submenu = false }: { readonly environmentId: string; readonly sessionId: string; readonly submenu?: boolean }) => {
  const runtime = useRuntime();
  const picker = useObservable(useMemo(() => runtime.projections.browsers(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const session = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [busy, setBusy] = useState(false);
  const [, say] = usePaneLine();
  const capability = runtime.capability(environmentId, "sessions.setBrowser");
  const choose = async (browser: SessionBrowser | null) => {
    setBusy(true);
    const answer = await runtime.commands.dispatch(environmentId, "sessions.setBrowser", { sessionId, browser });
    const label = picker.rows.find((row) => JSON.stringify(row.value) === JSON.stringify(browser))?.label ?? "Default";
    say(answer.ok ? `Browser set to ${label} for the next run.` : `Browser not changed: ${answer.error.message}`);
    setBusy(false);
  };
  const run = session.runs.at(-1);
  const resolved = run === undefined ? undefined : session.browserResolutions[run.runId];
  const resolvedLabel = resolved === undefined ? undefined
    : picker.rows.find((row) => JSON.stringify(row.value) === JSON.stringify(resolved.browser))?.label
      ?? (resolved.browser.kind === "chrome" ? "My Chrome" : resolved.browser.kind === "headless" ? "Headless browser" : resolved.browser.kind === "dock" ? `${PRODUCT_NAME}'s built-in browser` : "None");
  const offer = busy ? { status: "absent" as const, message: "Changing the browser." } : capability;
  if (submenu) return <BrowserChoiceSubmenu rows={picker.rows} choose={(browser) => void choose(browser)} offer={offer} />;
  return <div className="contents">
    <BrowserChoiceMenu rows={picker.rows} choose={(browser) => void choose(browser)} detail={resolved === undefined ? undefined : `${run?.state === "running" ? "This run" : "Last run"}: ${resolvedLabel}. ${resolved.message}`} className="h-[22px] max-w-[240px] min-w-0 gap-1 rounded-md bg-wash px-1.5 text-2xs font-normal hover:bg-wash-strong aria-expanded:bg-wash-strong [&_svg]:size-3" offer={offer} />
    {resolved !== undefined && <span className="sr-only">{run?.state === "running" ? "This run" : "Last run"}: {resolvedLabel}. {resolved.message}</span>}
  </div>;
};

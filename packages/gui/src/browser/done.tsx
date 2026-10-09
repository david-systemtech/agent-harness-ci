import { adminCall, plainRefusal, uuidv7, type PlainRefusal } from "@agent-harness/client-runtime";
import { BrowserReach, type PairedChrome } from "@agent-harness/contracts";
import { Check } from "lucide-react";
import { useId, useState } from "react";
import { Button, Fold } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { BrowserProblem, useBrowserDetails } from "./pairing-code.js";

const USE = "Use my Chrome for agents";

/**
 * Use my Chrome for agents (setup-copy.md §5.11): it re-reads the account list
 * and reach immediately before writing, and presets My Chrome only for the
 * accounts still at per-session, keeping every other choice; when every
 * account already has a browser chosen it writes nothing and says so. Held, with its
 * reason in view, until a Chrome is paired. Beneath it, the fold How agents
 * use Chrome holds the browser glossary, each paired Chrome by its name.
 */
export const BrowserDone = ({ environmentId, chromeEnvironmentId, chromes }: { readonly environmentId: string; readonly chromeEnvironmentId: string; readonly chromes: readonly PairedChrome[] }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const details = useBrowserDetails(environmentId);
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [refused, refuse] = useState<PlainRefusal | null>(null);
  const [glossary, showGlossary] = useState(false);
  const paired = chromes.length > 0;
  const finish = async () => {
    setBusy(true);
    refuse(null);
    const stop = (refusal: PlainRefusal) => {
      refuse(refusal);
      setBusy(false);
    };
    const [accounts, settings] = await Promise.all([runtime.requests.call(environmentId, "accounts.list", {}), runtime.requests.call(environmentId, "settings.get", { keys: ["browser.reach"] })]);
    if (!accounts.ok) return stop(plainRefusal(accounts.error, USE));
    if (!settings.ok) return stop(plainRefusal(settings.error, USE));
    const read = BrowserReach.safeParse(settings.result.values["browser.reach"]);
    if (!read.success) return stop({ line: `Something went wrong. Choose ${USE} to try again.`, details: ["browser.reach: the computer did not return valid browser reach settings"] });
    const reach = read.data;
    const preset = accounts.result.accounts.filter((account) => reach[account.id] === undefined || reach[account.id] === "per-session");
    for (const account of preset) reach[account.id] = { chrome: { environmentId: chromeEnvironmentId, chromeId: null } };
    if (preset.length > 0) {
      const saved = await adminCall(() => runtime.requests.call(environmentId, "settings.update", { commandId: uuidv7(clock.now()), values: { "browser.reach": reach } }));
      if (!saved.ok) return stop(plainRefusal(saved.refusal, USE));
    }
    setDone(preset.length > 0 ? "Agents now use your Chrome." : "Every account already has a browser chosen, so nothing changed.");
    setBusy(false);
  };
  const writable = runtime.capability(environmentId, "settings.update").status === "present";
  return (
    <section aria-label={USE} className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" className="self-start" aria-describedby={paired ? undefined : reasonId} disabled={!paired || !writable || busy || done !== null} onClick={() => void finish()}>
          <Check aria-hidden="true" />{USE}
        </Button>
        {!paired && <p id={reasonId} className="text-xs text-ink-muted">Pair Chrome first (step 5).</p>}
      </div>
      {done !== null && <p role="status" data-browser-after>{done}</p>}
      {refused !== null && <BrowserProblem line={refused.line} details={details(refused.line, refused.details)} />}
      <Fold summary="How agents use Chrome" open={glossary} onOpenChange={showGlossary}>
        <dl data-browser-definitions className="grid min-w-0 grid-cols-1 gap-x-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] [&_dt]:py-2 [&_dt]:font-medium [&_dd]:py-2 [&_dd]:text-ink-muted">
          <dt>My Chrome (agent-harness extension)</dt>
          <dd>Your real Chrome, with your logins. The agent works in a tab group it keeps to itself, and some sites are refused.<p>Whichever of them is open.</p></dd>
          {chromes.map((chrome) => <div key={chrome.id} className="contents">
            <dt>{`My Chrome: ${chrome.name}`}</dt>
            <dd>Always this browser, whatever else is open.</dd>
          </div>)}
          <dt>Headless browser</dt>
          <dd>A browser on the session's computer that nobody can see. Signed in to nothing, and the agent can read, click and type in it.</dd>
          <dt>agent-harness's built-in browser</dt>
          <dd>A tab inside the agent-harness window. Signed in to nothing, and the agent can read, click and type in it.</dd>
          <dt>Per-session reach</dt>
          <dd>No Chrome until one is chosen in the session.</dd>
          <dt>Chrome always</dt>
          <dd>This Chrome for every new session of the account.</dd>
        </dl>
      </Fold>
    </section>
  );
};

import { adminCall, uuidv7 } from "@agent-harness/client-runtime";
import { BrowserReach } from "@agent-harness/contracts";
import { useState } from "react";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** Done re-reads the account list and reach immediately before writing, preserving every non-preset choice. */
export const BrowserDone = ({ environmentId, chromeEnvironmentId, paired }: { readonly environmentId: string; readonly chromeEnvironmentId: string; readonly paired: boolean }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [line, say] = useState<string | null>(null);
  const finish = async () => {
    setBusy(true);
    const [accounts, settings] = await Promise.all([runtime.requests.call(environmentId, "accounts.list", {}), runtime.requests.call(environmentId, "settings.get", { keys: ["browser.reach"] })]);
    if (!accounts.ok) {
      say(`Reach not saved: ${accounts.error.message}`);
      setBusy(false);
      return;
    }
    if (!settings.ok) {
      say(`Reach not saved: ${settings.error.message}`);
      setBusy(false);
      return;
    }
    const read = BrowserReach.safeParse(settings.result.values["browser.reach"]);
    if (!read.success) {
      say("Reach not saved: The environment did not return valid browser reach settings.");
      setBusy(false);
      return;
    }
    const reach = read.data;
    const preset = accounts.result.accounts.filter((account) => reach[account.id] === undefined || reach[account.id] === "per-session");
    for (const account of preset) reach[account.id] = { chrome: { environmentId: chromeEnvironmentId, chromeId: null } };
    if (preset.length > 0) {
      const saved = await adminCall(() => runtime.requests.call(environmentId, "settings.update", { commandId: uuidv7(clock.now()), values: { "browser.reach": reach } }));
      if (!saved.ok) {
        say(`Reach not saved: ${saved.line}`);
        setBusy(false);
        return;
      }
    }
    say(
      preset.length > 0
        ? `My Chrome set as the reach for ${preset.map((account) => account.label).join(", ")}. Accounts already set keep their reach.`
        : "No accounts are still at the preset. Their reach stays as it is.",
    );
    setDone(true);
    setBusy(false);
  };
  const writable = runtime.capability(environmentId, "settings.update").status === "present";
  return (
    <section aria-label="Done" className="flex flex-col gap-2">
      <label>
        <input type="checkbox" checked={done} readOnly disabled /> Done
      </label>
      <Button disabled={!paired || !writable || busy || done} onClick={() => void finish()}>
        Done
      </Button>
      {line !== null && <p role="status">{line}</p>}
      {done && (
        <section aria-label="Using your browser" className="flex flex-col gap-2">
          <h3>Using your browser</h3>
          <dl>
            <dt>My Chrome (agent-harness extension)</dt>
            <dd>Your real Chrome, with your logins. The agent works in a tab group it keeps to itself, and some sites are refused.</dd>
            <dd>Whichever of them is open.</dd>
            <dt>My Chrome: &lt;name&gt;</dt>
            <dd>Always this browser, whatever else is open.</dd>
            <dt>Headless browser</dt>
            <dd>A browser on the session's environment that nobody can see. Signed in to nothing, and the agent can read, click and type in it.</dd>
            <dt>agent-harness's built-in browser</dt>
            <dd>A tab inside the agent-harness window. Signed in to nothing, and the agent can read, click and type in it.</dd>
            <dt>Per-session reach</dt>
            <dd>No Chrome until one is chosen in the session.</dd>
            <dt>Chrome always</dt>
            <dd>This Chrome for every new session of the account.</dd>
          </dl>
        </section>
      )}
    </section>
  );
};

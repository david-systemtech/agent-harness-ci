import type { CachedAnswer, EnvironmentView } from "@agent-harness/client-runtime";
import { useRef, useState } from "react";
import { useWindowAction } from "../keys/key-dispatch.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { useRuntime } from "../window-context.js";

export const BrowserHeadless = ({ view, status }: { readonly view: EnvironmentView; readonly status: CachedAnswer<"browser.status"> }) => {
  const { values, save } = useSettingsValues(view.environmentId);
  const runtime = useRuntime();
  const capability = runtime.capability(view.environmentId, "settings.update");
  const field = useRef<HTMLInputElement>(null);
  const [line, say] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useWindowAction("app.browser.allowRuns", () => field.current?.focus(), capability);
  const headless = status.result?.headless;
  const availability = headless?.availability;
  const source = availability?.available ? availability.source : undefined;
  const allow = async (next: boolean) => {
    setBusy(true);
    const saved = await save("browser.headless.allowRuns", next);
    say(saved.ok ? `Headless browser ${next ? "allowed" : "not allowed"} for runs.` : `Not saved: ${saved.line}`);
    setBusy(false);
  };
  return (
    <section aria-label="Headless browser" className="flex flex-col gap-2">
      <h3>Headless browser</h3>
      {view.phase !== "ready" && <p className="text-amber">Cached headless state — stale.</p>}
      {availability !== undefined && <p>{availability.available ? `Available: ${source?.kind === "endpoint" ? source.endpoint : source?.executable}. ${headless?.liveContexts} live contexts.` : availability.reason}</p>}
      {status.error !== null && <p role="status">{status.error.message}</p>}
      <label>
        <input ref={field} type="checkbox" disabled={capability.status === "absent" || values === null || busy}
          checked={values?.["browser.headless.allowRuns"] === true}
          onChange={(event) => void allow(event.target.checked)} /> Allow runs to use the headless browser
      </label>
      {capability.status === "absent" && <p>{capability.message}</p>}
      {line !== null && <p role="status">{line}</p>}
    </section>
  );
};

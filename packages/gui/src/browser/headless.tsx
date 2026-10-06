import type { CachedAnswer, EnvironmentView } from "@agent-harness/client-runtime";
import { Bot, Globe } from "lucide-react";
import { Switch, Tooltip } from "../ui/index.js";
import { useRef, useState } from "react";
import { useFirstKey, useWindowAction } from "../keys/key-dispatch.js";
import { BrowserProblem } from "./pairing-code.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { useRuntime } from "../window-context.js";

export const BrowserHeadless = ({ view, status }: { readonly view: EnvironmentView; readonly status: CachedAnswer<"browser.status"> }) => {
  const { values, save } = useSettingsValues(view.environmentId);
  const runtime = useRuntime();
  const capability = runtime.capability(view.environmentId, "settings.update");
  const field = useRef<HTMLButtonElement>(null);
  const [line, say] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useWindowAction("app.browser.allowRuns", () => field.current?.focus(), capability);
  const keys = useFirstKey("app.browser.allowRuns");
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
    <section aria-label="Headless browser" className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-medium"><Bot aria-hidden="true" className="size-4" />Headless browser</h3>
      {view.phase !== "ready" && <p className="text-amber">Cached headless state — stale.</p>}
      {availability !== undefined && <p className="break-all font-mono text-2xs text-ink-muted">{availability.available ? `Available: ${source?.kind === "endpoint" ? source.endpoint : source?.executable}. ${headless?.liveContexts} live contexts.` : availability.reason}</p>}
      {status.error !== null && <BrowserProblem line={status.error.message} code={status.error.code} />}
      <label className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="flex items-center gap-1.5"><Globe aria-hidden="true" className="size-4" />Allow runs to use the headless browser</span>
        <Tooltip content="Allow runs to use the headless browser" keys={`Space to toggle${keys === undefined ? "" : `; ${keys}`}`}><Switch ref={field} aria-label="Allow runs to use the headless browser" disabled={capability.status === "absent" || values === null || busy} checked={values?.["browser.headless.allowRuns"] === true} onCheckedChange={(next) => void allow(next)} /></Tooltip>
      </label>
      <p className="text-2xs text-ink-muted">Let agents use the environment's browser without pairing Chrome. Availability depends on this machine.</p>
      {capability.status === "absent" && <p>{capability.message}</p>}
      {line !== null && <p role="status">{line}</p>}
    </section>
  );
};

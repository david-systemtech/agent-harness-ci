import { uuidv7, type EnvironmentView } from "@agent-harness/client-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, Textarea } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { useSettings } from "../settings/settings-window.js";
import { Part } from "./machine-card.js";

/** Two directions of trust are explicit: clients admitted here, environments this bundle may contact. An opening at `browser-origins` for this environment goes to them (#1713). */
export const WebOrigins = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime(); const clock = useClock();
  const { part, picked, openings } = useSettings();
  const region = useRef<HTMLElement>(null);
  // Each opening is gone to once: a later pick of another environment under the same opening (Set up this machine) leaves the focus be.
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (seen.current === openings) return;
    seen.current = openings;
    if (part !== "browser-origins" || picked !== view.environmentId) return;
    if (typeof region.current?.scrollIntoView === "function") region.current.scrollIntoView({ block: "start" });
    region.current?.focus();
  }, [part, picked, openings, view.environmentId]);
  const answer = useObservable(useMemo(() => runtime.requests.cached(view.environmentId, "web.origins.get", {}), [runtime, view.environmentId]));
  const [clients, setClients] = useState<string>(); const [connections, setConnections] = useState<string>();
  const [line, setLine] = useState<string>(); const [saving, setSaving] = useState(false);
  const writable = runtime.capability(view.environmentId, "web.origins.set").status === "present";
  const disabled = !writable || saving || answer.loading || answer.error !== null;
  const split = (value: string) => value.split(/\s+/).filter(Boolean);
  const save = async () => {
    setSaving(true);
    const result = await runtime.requests.call(view.environmentId, "web.origins.set", { commandId: uuidv7(clock.now()), clientOrigins: split(clients ?? answer.result?.clientOrigins.join("\n") ?? ""), connectOrigins: split(connections ?? answer.result?.connectOrigins.join("\n") ?? "") });
    if (result.ok) {
      runtime.requests.refresh(view.environmentId, "web.origins.get", {});
      setClients(undefined); setConnections(undefined);
    }
    setSaving(false);
    setLine(result.ok ? "Origins saved. Reload the browser client to apply connection permissions." : result.error.message);
  };
  return <Part ref={region} title="Browser origins">
    <p className="text-sm text-ink-muted">To pair a second HTTPS environment, its trusted admin must allow this browser client's exact origin. Also allow that environment's origin here so this client can contact it. Each list accepts one HTTPS origin per line, including a port when present.</p>
    {!writable && <p className="text-sm text-ink-muted">A trusted admin must change these lists. Re-pair with an explicitly expanded grant if needed.</p>}
    {answer.result === null ? <p className="text-sm text-ink-faint">{answer.error?.message ?? "Reading browser origins…"}</p> : <>
      <Field label="Allowed client origins"><Textarea title="Allowed client origins (one HTTPS origin per line)" value={clients ?? answer.result.clientOrigins.join("\n")} disabled={disabled} onChange={event => setClients(event.target.value)} className="font-mono" /></Field>
      <Field label="Allowed connection origins"><Textarea title="Allowed connection origins (one HTTPS origin per line)" value={connections ?? answer.result.connectOrigins.join("\n")} disabled={disabled} onChange={event => setConnections(event.target.value)} className="font-mono" /></Field>
      <Button disabled={disabled} onClick={() => void save()} title="Save browser origins (Enter or Space)">Save origins</Button>
    </>}
    {answer.result !== null && answer.error && <p role="status" className="text-sm text-ink-muted">{answer.error.message}</p>}
    {line && <p role="status" className="text-sm text-ink-muted">{line}</p>}
  </Part>;
};

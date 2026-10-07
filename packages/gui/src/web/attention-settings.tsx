import { createPortal } from "react-dom";
import { EndpointName, type AttentionTargetStatus } from "@agent-harness/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { Bell, RefreshCw, X } from "lucide-react";
import { Button } from "../ui/button.js";
import { Input } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { usePickedEnvironment, useSettings } from "../settings/settings-window.js";
import type { WebModule } from "../platform/web-registrations.js";

export interface AttentionSettingsProps {
  readonly targets: readonly AttentionTargetStatus[];
  readonly admin: boolean;
  readonly busy: boolean;
  readonly onConfigure: (id: string, enabled: boolean, completion: boolean, global: boolean) => void;
  readonly onRemove: (id: string, global: boolean) => void;
  readonly onRefresh: () => void;
  /** Makes the named endpoint and its global route; resolves true once both are saved. */
  readonly onAddRoute: (route: WebhookRouteInput) => Promise<boolean>;
  /** Posts a signed test to a webhook route's named endpoint. */
  readonly onTest: (endpoint: string) => void;
}
/** What an admin types to add a signed-webhook route: the endpoint's name, its URL and its signing secret. */
export interface WebhookRouteInput { readonly name: string; readonly url: string; readonly secret: string }
/** A target is named by its label; a push registration's id is an opaque client session id that means nothing to a person. */
export const attentionTargetLabel = (target: AttentionTargetStatus): string => target.label ?? (target.transport === "push" ? "Web Push registration" : target.id);
/** Status and preference controls never receive a transport's URL, keys or secrets; the route form sends a secret once and never reads it back. */
export const AttentionSettingsPane = ({ targets, admin, busy, onConfigure, onRemove, onRefresh, onAddRoute, onTest }: AttentionSettingsProps) => (
  <section data-attention-settings className="flex min-w-0 flex-col gap-3 break-words text-base">
    <p className="text-ink-muted">A waiting ask is delivered after six seconds. No prompt, transcript, session title or secrets appear in the notification.</p>
    <p className="text-ink-muted">In-app Parked asks work while connected. Closed-phone delivery needs an enabled push subscription or a configured webhook fallback.</p>
    {!admin && <p className="text-ink-muted">Global routes require admin. Re-pair with an explicit admin grant to configure them.</p>}
    <Button title="Refresh attention status" className="h-11 self-start" onClick={onRefresh} disabled={busy}><RefreshCw aria-hidden="true" />Refresh status</Button>
    {targets.length === 0 && <p role="status">{admin ? "No delivery targets are registered. Add a webhook route or enable Web Push below." : "No delivery targets are registered. Enable Web Push or choose a configured fallback when that transport is available."}</p>}
    {targets.map(target => {
      const locked = busy || (target.global && !admin);
      const label = attentionTargetLabel(target);
      const testable = admin && target.global ? target.webhookEndpoint : undefined;
      return <article key={target.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
        <h3 className="font-semibold">{label}</h3>
        <p>{target.transport === "push" ? "Web Push" : "Signed webhook"} · {target.global ? "Global route" : "This client"} · <span role="status">{target.state}</span></p>
        {target.state === "unavailable" && <p className="text-ink-muted">The delivery transport or canonical HTTPS origin is unavailable. In-app attention cannot alert a closed browser.</p>}
        {target.failure && <p role="alert" className="text-signal">{target.failure}</p>}
        <div className="flex flex-wrap gap-2">
          <Button className="h-11" title={`${target.enabled ? "Disable" : "Enable"} ${label}`} aria-label={`${target.enabled ? "Disable" : "Enable"} ${label}`} disabled={locked} onClick={() => onConfigure(target.id, !target.enabled, target.completion, target.global)}>{target.enabled ? "Disable" : "Enable"}</Button>
          <Button className="h-11" title={`Remove ${label}`} aria-label={`Remove ${label}`} disabled={locked} onClick={() => onRemove(target.id, target.global)}>Remove</Button>
          {testable && <Button className="h-11" title={`Post a signed test to ${testable}`} aria-label={`Test ${label}`} disabled={busy} onClick={() => onTest(testable)}>Test</Button>}
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input type="checkbox" className="size-5 shrink-0" aria-label={`Routine completions for ${label}`} checked={target.completion} disabled={locked} onChange={event => onConfigure(target.id, target.enabled, event.target.checked, target.global)} />
          <span>Also deliver routine completions (silent outcomes stay quiet)</span>
        </label>
      </article>;
    })}
    {admin && <WebhookRouteForm busy={busy} onAdd={onAddRoute} />}
  </section>
);

/** An admin's way to the closed-phone fallback: the named endpoint (URL and signing secret) and the global route that names it. */
const WebhookRouteForm = ({ busy, onAdd }: { readonly busy: boolean; readonly onAdd: (route: WebhookRouteInput) => Promise<boolean> }) => {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [problem, setProblem] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!EndpointName.safeParse(name.trim()).success) return setProblem("A name is 1 to 40 lower-case letters, digits and hyphens.");
    if (url.trim() === "" || secret === "") return setProblem("Type the receiver's URL and its signing secret.");
    setProblem(undefined);
    if (await onAdd({ name: name.trim(), url: url.trim(), secret })) { setName(""); setUrl(""); setSecret(""); }
  };
  const field = "flex min-h-11 flex-col gap-1";
  return <form aria-label="Add a webhook route" className="flex min-w-0 flex-col gap-3 rounded-lg border border-hairline bg-panel p-3" onSubmit={event => { void submit(event); }}>
    <h3 className="font-semibold">Add a webhook route</h3>
    <p className="text-ink-muted">A signed webhook reaches a closed phone through a receiver you run, for example one that forwards to a chat room. The secret is kept in this environment's vault and never shown again.</p>
    <label className={field}><span>Name</span><Input className="h-11" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="phone-attention" value={name} onChange={event => setName(event.target.value)} /></label>
    <label className={field}><span>Receiver URL</span><Input className="h-11" type="url" inputMode="url" autoComplete="off" placeholder="https://receiver.example/attention" value={url} onChange={event => setUrl(event.target.value)} /></label>
    <label className={field}><span>Signing secret</span><Input className="h-11" type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} /></label>
    {problem && <p role="alert" className="text-signal">{problem}</p>}
    <Button type="submit" className="h-11 self-start" disabled={busy}>Add route</Button>
  </form>;
};

const ConnectedAttention = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "attention.targets.list", {}), [runtime, environmentId]));
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string>();
  const admin = runtime.capability(environmentId, "attention.routes.set").status === "present";
  const refresh = () => runtime.requests.refresh(environmentId, "attention.targets.list", {});
  useEffect(() => {
    let timer = clock.setTimeout(poll, 10_000);
    function poll() { runtime.requests.refresh(environmentId, "attention.targets.list", {}); timer = clock.setTimeout(poll, 10_000); }
    return () => timer.cancel();
  }, [clock, runtime, environmentId]);
  const write = async (id: string, global: boolean, preferences?: { readonly enabled: boolean; readonly completion: boolean }) => {
    setBusy(true); setLine(undefined);
    try {
      const commandId = crypto.randomUUID();
      const result = preferences
        ? await runtime.requests.call(environmentId, global ? "attention.routes.configure" : "attention.targets.configure", { commandId, id, ...preferences })
        : await runtime.requests.call(environmentId, global ? "attention.routes.remove" : "attention.targets.remove", { commandId, id });
      setLine(result.ok && result.result.receipt.status === "accepted" ? "Attention preferences saved." : "Could not save attention preferences. Check your connection and grant.");
      refresh();
    } catch { setLine("Could not save attention preferences. Check your connection and grant."); }
    finally { setBusy(false); }
  };
  /** A global route naming the endpoint, as the environment lists it now; undefined when the list cannot be read. */
  const routeNaming = async (name: string) => {
    const listed = await runtime.requests.call(environmentId, "attention.targets.list", {}).catch(() => null);
    return listed?.ok ? { route: listed.result.targets.find(target => target.global && target.webhookEndpoint === name), targets: listed.result.targets } : undefined;
  };
  /**
   * The route first, then the endpoint it names, so a refused route leaves no secret behind and a retry under the same
   * name finishes a route whose endpoint step failed. An endpoint no route of this sheet names is never replaced: other
   * clients' own targets, which this client cannot list, may deliver to it.
   */
  const addRoute = async ({ name, url, secret }: WebhookRouteInput): Promise<boolean> => {
    setBusy(true); setLine(undefined);
    try {
      const [endpoints, current] = await Promise.all([runtime.requests.call(environmentId, "routines.endpoints.list", {}), routeNaming(name)]);
      if (!endpoints.ok || !current) throw new Error("Status unavailable.");
      const { route, targets } = current;
      if (!route && endpoints.result.endpoints.some(endpoint => endpoint.name === name)) { setLine(`An endpoint named ${name} already exists on this environment. Choose another name.`); return false; }
      if (!route && targets.some(target => target.id === name)) { setLine(`A delivery target named ${name} already exists. Choose another name.`); return false; }
      const target = { id: route?.id ?? name, ...(route?.label === undefined ? {} : { label: route.label }), transport: "webhook" as const, enabled: true, completion: route?.completion ?? false, configuration: { endpoint: name } };
      const set = await runtime.requests.call(environmentId, "attention.routes.set", { commandId: crypto.randomUUID(), target }).catch(() => null);
      const refusedRoute = !set ? "Check your connection and admin grant." : !set.ok ? set.error.message : set.result.receipt.status === "rejected" ? set.result.receipt.error.message : null;
      // A timeout or a lost answer says nothing of whether the route was applied: what the environment lists now decides.
      if (refusedRoute !== null && !(await routeNaming(name))?.route) { setLine(`Webhook route not saved: ${refusedRoute}`); refresh(); return false; }
      const endpoint = await runtime.requests.call(environmentId, "routines.endpoints.set", { commandId: crypto.randomUUID(), name, url, secret: { kind: "pasted", secret } });
      const refused = !endpoint.ok ? endpoint.error.message : endpoint.result.receipt.status === "rejected" ? endpoint.result.receipt.error.message : null;
      if (refused !== null) { setLine(`Webhook route not saved: ${refused}`); refresh(); return false; }
      setLine(`Webhook route ${name} saved. Test it to check that its receiver takes the signed post.`);
      refresh();
      return true;
    } catch { setLine("Could not save the webhook route. Check your connection and admin grant."); return false; }
    finally { setBusy(false); }
  };
  const test = async (endpoint: string) => {
    setBusy(true); setLine(`Posting a signed test to ${endpoint}…`);
    try {
      const answer = await runtime.requests.call(environmentId, "routines.endpoints.test", { name: endpoint });
      if (!answer.ok) setLine(`Not tested: ${answer.error.message}`);
      else setLine(answer.result.error === null ? `${endpoint} answered ${answer.result.status ?? "nothing"} in ${answer.result.durationMs} ms.` : `${endpoint} did not take the test: ${answer.result.error}`);
    } catch { setLine("Could not test the webhook route. Check your connection and admin grant."); }
    finally { setBusy(false); }
  };
  return <>
    {(line || answer.error) && <p role="status" className="mb-3 text-ink-muted">{line ?? "Could not read attention status. Check your connection and read grant."}</p>}
    <AttentionSettingsPane targets={answer.result?.targets ?? []} admin={admin} busy={busy} onRefresh={refresh}
      onConfigure={(id, enabled, completion, global) => { void write(id, global, { enabled, completion }); }} onRemove={(id, global) => { void write(id, global); }}
      onAddRoute={addRoute} onTest={endpoint => { void test(endpoint); }} />
  </>;
};

/** Registered Settings surface consumes the web slot without modifying another surface owner's row. */
export const AttentionSettings = () => {
  const settings = useSettings();
  const picked = usePickedEnvironment();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Element | null>(null);
  useEffect(() => {
    if (!settings.shown) { setAnchor(null); return; }
    const find = () => setAnchor(document.querySelector("[data-settings-dialog] header"));
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    find();
    return () => observer.disconnect();
  }, [settings.shown]);
  useEffect(() => { if (!settings.shown) setOpen(false); }, [settings.shown]);
  if (!settings.shown) return null;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    {anchor && createPortal(<Dialog.Trigger asChild><Button className="h-11 w-11 bg-panel" aria-label="Attention settings" title="Attention settings"><Bell aria-hidden="true" /></Button></Dialog.Trigger>, anchor)}
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[60] bg-abyss/80" />
      <Dialog.Content className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[90dvh] min-w-0 flex-col rounded-t-xl bg-float p-4 text-ink outline-none sm:left-1/2 sm:top-1/2 sm:w-[min(560px,90vw)] sm:-translate-x-1/2 sm:-translate-y-1/2">
        <header className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <Dialog.Title className="text-base font-semibold">Attention</Dialog.Title>
          <Dialog.Close asChild><Button className="h-11 w-11" title="Close attention settings · Escape" aria-label="Close attention settings"><X aria-hidden="true" /></Button></Dialog.Close>
        </header>
        <Dialog.Description className="mb-3 text-base text-ink-muted">Delivery targets for {picked?.name ?? "the selected environment"}.</Dialog.Description>
        <div className="min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          {picked ? <ConnectedAttention key={picked.environmentId} environmentId={picked.environmentId} /> : <p>No paired environment is selected.</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
};
export const webModule: WebModule = { slot: "attention-settings", registration: { Surface: AttentionSettings } };

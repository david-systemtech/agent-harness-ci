import { createPortal } from "react-dom";
import type { AttentionTargetStatus } from "@agent-harness/contracts";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import { Bell, RefreshCw, X } from "lucide-react";
import { Button } from "../ui/button.js";
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
}
/** A target is named by its label; a push registration's id is an opaque client session id that means nothing to a person. */
export const attentionTargetLabel = (target: AttentionTargetStatus): string => target.label ?? (target.transport === "push" ? "Web Push registration" : target.id);
/** Status and preference controls never receive transport endpoints, keys or secrets. */
export const AttentionSettingsPane = ({ targets, admin, busy, onConfigure, onRemove, onRefresh }: AttentionSettingsProps) => (
  <section data-attention-settings className="flex min-w-0 flex-col gap-3 break-words text-base">
    <p className="text-ink-muted">A waiting ask is delivered after six seconds. No prompt, transcript, session title or secrets appear in the notification.</p>
    <p className="text-ink-muted">In-app Parked asks work while connected. Closed-phone delivery needs an enabled push subscription or a configured webhook fallback.</p>
    {!admin && <p className="text-ink-muted">Global routes require admin. Re-pair with an explicit admin grant to configure them.</p>}
    <Button title="Refresh attention status" className="h-11 self-start" onClick={onRefresh} disabled={busy}><RefreshCw aria-hidden="true" />Refresh status</Button>
    {targets.length === 0 && <p role="status">No delivery targets are registered. Enable Web Push or choose a configured fallback when that transport is available.</p>}
    {targets.map(target => {
      const locked = busy || (target.global && !admin);
      const label = attentionTargetLabel(target);
      return <article key={target.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
        <h3 className="font-semibold">{label}</h3>
        <p>{target.transport === "push" ? "Web Push" : "Signed webhook"} · {target.global ? "Global route" : "This client"} · <span role="status">{target.state}</span></p>
        {target.state === "unavailable" && <p className="text-ink-muted">The delivery transport or canonical HTTPS origin is unavailable. In-app attention cannot alert a closed browser.</p>}
        {target.failure && <p role="alert" className="text-signal">{target.failure}</p>}
        <div className="flex flex-wrap gap-2">
          <Button className="h-11" title={`${target.enabled ? "Disable" : "Enable"} ${label}`} aria-label={`${target.enabled ? "Disable" : "Enable"} ${label}`} disabled={locked} onClick={() => onConfigure(target.id, !target.enabled, target.completion, target.global)}>{target.enabled ? "Disable" : "Enable"}</Button>
          <Button className="h-11" title={`Remove ${label}`} aria-label={`Remove ${label}`} disabled={locked} onClick={() => onRemove(target.id, target.global)}>Remove</Button>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input type="checkbox" className="size-5 shrink-0" aria-label={`Routine completions for ${label}`} checked={target.completion} disabled={locked} onChange={event => onConfigure(target.id, target.enabled, event.target.checked, target.global)} />
          <span>Also deliver routine completions (silent outcomes stay quiet)</span>
        </label>
      </article>;
    })}
  </section>
);

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
  return <>
    {(line || answer.error) && <p role="status" className="mb-3 text-ink-muted">{line ?? "Could not read attention status. Check your connection and read grant."}</p>}
    <AttentionSettingsPane targets={answer.result?.targets ?? []} admin={admin} busy={busy} onRefresh={refresh}
      onConfigure={(id, enabled, completion, global) => { void write(id, global, { enabled, completion }); }} onRemove={(id, global) => { void write(id, global); }} />
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

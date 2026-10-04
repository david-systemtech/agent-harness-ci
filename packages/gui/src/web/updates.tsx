import { useEffect, useSyncExternalStore } from "react";
import { writable } from "@agent-harness/client-runtime";
import { reportOfflineUnavailable } from "./install.js";
import { Button } from "../ui/button.js";
import type { WebModule } from "../platform/web-registrations.js";

interface UpdateState { readonly available: boolean; readonly composing: boolean; readonly busy: boolean; readonly error?: string }
interface WaitingWorker { postMessage(message: string): void }
/** No activation or navigation happens until the user chooses Reload and the runtime persists its drafts. */
export class UpdateController {
  private readonly state = writable<UpdateState>({ available: false, composing: false, busy: false });
  readonly read = this.state.read;
  readonly subscribe = this.state.subscribe;
  private worker: WaitingWorker | undefined;
  private requested = false;
  private activatedElsewhere = false;
  private readonly begin = () => this.state.update(state => ({ ...state, composing: true }));
  private readonly end = () => this.state.update(state => ({ ...state, composing: false }));
  private readonly changed = () => {
    if (this.requested) { this.requested = false; this.navigate(); }
    else if (this.read().available) this.activatedElsewhere = true;
  };
  constructor(private readonly events: EventTarget, private readonly save: () => Promise<void>, private readonly navigate: () => void) {
    events.addEventListener("compositionstart", this.begin);
    events.addEventListener("compositionend", this.end);
    events.addEventListener("controllerchange", this.changed);
  }
  offer(worker: WaitingWorker): void { this.activatedElsewhere = false; this.worker = worker; this.state.update(state => ({ ...state, available: true })); }
  async reload(): Promise<boolean> {
    if (!this.worker || this.read().composing || this.read().busy) return false;
    this.state.update(state => ({ ...state, busy: true }));
    try {
      await this.save();
      if (this.activatedElsewhere) { this.navigate(); return true; }
      this.requested = true;
      this.worker.postMessage("activate-public-update");
      return true;
    } catch {
      this.requested = false;
      this.state.update(state => ({ ...state, busy: false, error: "Could not save your draft. Keep this client open and try again when storage is available." }));
      return false;
    }
  }
  dispose(): void {
    this.events.removeEventListener("compositionstart", this.begin);
    this.events.removeEventListener("compositionend", this.end);
    this.events.removeEventListener("controllerchange", this.changed);
  }
}

export const UpdateNotice = ({ controller }: { readonly controller: UpdateController }) => {
  const state = useSyncExternalStore(controller.subscribe, controller.read);
  useEffect(() => {
    if (!state.busy) return;
    const regions = Array.from(document.querySelectorAll<HTMLElement>("[data-web-client] > main, [data-web-client] > header"));
    const previous = regions.map(region => region.inert);
    for (const region of regions) region.inert = true;
    return () => { regions.forEach((region, index) => { region.inert = previous[index] ?? false; }); };
  }, [state.busy]);
  if (!state.available) return null;
  return <section data-client-update aria-label="Client update" className="shrink-0 border-t border-hairline bg-panel px-3 py-2">
    <p role="status" className="text-sm">A new client is ready. Reload when you are ready; your saved draft is retained.</p>
    {state.error && <p role="alert" className="text-sm text-signal">{state.error}</p>}
    {state.composing && <p className="text-sm text-ink-muted">Finish composing before reloading.</p>}
    <Button title="Reload client" className="h-11" disabled={state.composing || state.busy} onClick={() => { void controller.reload(); }}>Reload client</Button>
  </section>;
};
const active = writable<UpdateController | undefined>(undefined);
const Updates = () => { const controller = useSyncExternalStore(active.subscribe, active.read); return controller ? <UpdateNotice controller={controller} /> : null; };

export const webModule: WebModule = { slot: "worker", registration: {
  Surface: Updates,
  start(runtime, platform) {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
    const events = new EventTarget();
    const relay = (event: Event) => events.dispatchEvent(new Event(event.type));
    for (const type of ["compositionstart", "compositionend"]) document.addEventListener(type, relay, true);
    navigator.serviceWorker.addEventListener("controllerchange", relay);
    const controller = new UpdateController(events, async () => {
      if (platform.persistence.read() !== "persistent") throw new Error("Storage unavailable.");
      await runtime.checkpoint();
      if (platform.persistence.read() !== "persistent") throw new Error("Storage unavailable.");
    }, () => window.location.reload());
    active.set(controller);
    let stopped = false;
    let cleanup: (() => void) | undefined;
    void navigator.serviceWorker.register("/service-worker.js", { type: "module", scope: "/", updateViaCache: "none" }).then(registration => {
      if (stopped) return;
      const follow = () => { if (registration.waiting && navigator.serviceWorker.controller) controller.offer(registration.waiting); };
      const installing = () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", follow);
        cleanup = () => { worker?.removeEventListener("statechange", follow); registration.removeEventListener("updatefound", installing); };
      };
      registration.addEventListener("updatefound", installing);
      installing(); follow();
    }).catch(() => { if (!stopped) reportOfflineUnavailable(); });
    return () => {
      stopped = true; cleanup?.(); controller.dispose(); active.set(undefined);
      for (const type of ["compositionstart", "compositionend"]) document.removeEventListener(type, relay, true);
      navigator.serviceWorker.removeEventListener("controllerchange", relay);
    };
  },
} };

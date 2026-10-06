import { useState, useSyncExternalStore } from "react";
import { writable } from "@agent-harness/client-runtime";
import { Button } from "../ui/button.js";
import type { WebModule } from "../platform/web-registrations.js";
import { runsInstalled } from "../platform/browser-name.js";

export interface InstallFeatures { readonly secure: boolean; readonly standalone: boolean; readonly ios: boolean; readonly worker: boolean }
interface InstallOffer extends Event { prompt(): Promise<void>; readonly userChoice: Promise<{ readonly outcome: string }> }
interface InstallState extends InstallFeatures { readonly installed: boolean; readonly offered: boolean; readonly busy: boolean; readonly line?: string | undefined }
export class InstallController {
  private readonly state;
  readonly read;
  readonly subscribe;
  private offer: InstallOffer | undefined;
  private readonly offered = (event: Event) => {
    if (!this.read().secure || this.read().standalone || this.read().installed) return;
    event.preventDefault(); this.offer = event as InstallOffer;
    this.state.update(state => ({ ...state, offered: true, line: undefined }));
  };
  private readonly installed = () => { this.offer = undefined; this.state.update(state => ({ ...state, installed: true, offered: false, line: "Client installed. Open its Home Screen icon." })); };
  constructor(private readonly events: EventTarget, features: InstallFeatures) {
    this.state = writable<InstallState>({ ...features, installed: features.standalone, offered: false, busy: false });
    this.read = this.state.read; this.subscribe = this.state.subscribe;
    events.addEventListener("beforeinstallprompt", this.offered);
    events.addEventListener("appinstalled", this.installed);
  }
  async install(): Promise<void> {
    const offer = this.offer;
    if (!offer || this.read().busy) return;
    this.state.update(state => ({ ...state, busy: true }));
    try {
      await offer.prompt();
      const answer = await offer.userChoice;
      this.state.update(state => ({ ...state, line: answer.outcome === "accepted" ? "Client installed. Open its Home Screen icon." : "Installation dismissed. You can try again from your browser's menu." }));
    } catch { this.state.update(state => ({ ...state, line: "Installation is unavailable or denied. Use your browser's menu to add a shortcut, or keep using this tab." })); }
    finally { this.offer = undefined; this.state.update(state => ({ ...state, busy: false, offered: false })); }
  }
  workerUnavailable(): void { this.state.update(state => ({ ...state, worker: false })); }
  dispose(): void { this.events.removeEventListener("beforeinstallprompt", this.offered); this.events.removeEventListener("appinstalled", this.installed); }
}
export const InstallGuidance = ({ controller }: { readonly controller: InstallController }) => {
  const state = useSyncExternalStore(controller.subscribe, controller.read);
  if (state.standalone) return null;
  return <section data-phone-install aria-label="Home Screen installation" className="flex min-w-0 flex-col gap-3 break-words rounded-lg border border-hairline bg-panel p-3">
    <h2 className="font-semibold">Open from your Home Screen</h2>
    {!state.secure ? <p>Use HTTPS for installation, offline assets and push. Plain HTTP may offer a bookmark or Home Screen shortcut without these capabilities.</p> : state.ios ? <p>On iPhone or iPad, open this client in Safari, tap Share, then Add to Home Screen and Open as Web App when offered.</p> : state.offered ? <p>Your browser offers installation. Tap Install client to add its Home Screen icon.</p> : <p>On Android, use your browser's Install or Add to Home Screen menu. If it is unavailable, keep using this tab or add a bookmark; your browser may support a shortcut only.</p>}
    {!state.worker && state.secure && <p>Offline assets are unavailable in this browser or blocked by its settings. You can keep using the connected client.</p>}
    <p className="text-ink-muted">Home Screen and browser tabs may use separate pairing storage. You may need to pair again in the installed client. Each keeps its own credentials; installing never copies them.</p>
    {state.line && <p role="status">{state.line}</p>}
    {state.offered && <Button className="h-11 self-start" title="Install client" disabled={state.busy} onClick={() => { void controller.install(); }}>Install client</Button>}
  </section>;
};
const active = writable<InstallController | undefined>(undefined);
export const reportOfflineUnavailable = (): void => active.read()?.workerUnavailable();
const InstallSurface = () => {
  const controller = useSyncExternalStore(active.subscribe, active.read);
  return controller ? <InstallSettingsRow controller={controller} /> : null;
};
const InstallSettingsRow = ({ controller }: { readonly controller: InstallController }) => {
  const state = useSyncExternalStore(controller.subscribe, controller.read);
  const [open, setOpen] = useState(false);
  if (state.standalone) return null;
  return <details data-install-disclosure className="min-w-0" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="flex min-h-11 cursor-pointer items-center text-sm">Add to Home Screen</summary>
    <InstallGuidance controller={controller} />
  </details>;
};
export const webModule = { slot: "install", registration: {
  Surface: InstallSurface,
  surfaceLocation: "settings-client",
  start: () => startInstallSurface(),
} } satisfies WebModule;

/** Shared browser lifecycle used by startup and scenes that include its real disclosure. */
export const startInstallSurface = (): (() => void) => {
  const standalone = runsInstalled(window);
  const controller = new InstallController(window, { secure: window.isSecureContext, standalone, ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1), worker: "serviceWorker" in navigator });
  active.set(controller);
  return () => { controller.dispose(); active.set(undefined); };
};

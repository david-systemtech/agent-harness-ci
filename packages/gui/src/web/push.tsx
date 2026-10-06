import { createPortal } from "react-dom";
import { usePickedEnvironment, useSettings } from "../settings/settings-window.js";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { writable } from "@agent-harness/client-runtime";
import type { AttentionTargetInput, AttentionTargetStatus } from "@agent-harness/contracts";
import { Button } from "../ui/button.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";
import type { WebModule } from "../platform/web-registrations.js";
import { servingConnection } from "../connections/browser-reach.js";

export interface PushSubscriptionData { readonly endpoint: string; readonly keys: { readonly auth: string; readonly p256dh: string } }
export interface PushBrowser {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscription(): Promise<PushSubscriptionData | null>;
  subscribe(key: string): Promise<PushSubscriptionData>;
  unsubscribe(expected?: PushSubscriptionData): Promise<void>;
}
export interface PushFeatures { readonly secure: boolean; readonly supported: boolean; readonly ios: boolean; readonly standalone: boolean }
interface PushActions { key(): Promise<string>; registered(): Promise<boolean>; set(subscription: PushSubscriptionData): Promise<void>; remove(): Promise<void>; test(): Promise<"sent" | "retry" | "retire"> }
export type PushState = "disabled" | "ready" | "denied" | "unavailable" | "install";
/** Browser permission and subscription are browser-owned; registration status remains environment-owned. */
export class PushController {
  private readonly state;
  readonly read;
  readonly subscribe;
  constructor(features: PushFeatures, private readonly browser: PushBrowser, private readonly actions: PushActions) {
    const status: PushState = !features.secure || !features.supported ? "unavailable" : features.ios && !features.standalone ? "install" : browser.permission() === "denied" ? "denied" : "disabled";
    this.state = writable<{ readonly status: PushState; readonly busy: boolean; readonly line?: string | undefined }>({ status, busy: false });
    this.read = this.state.read; this.subscribe = this.state.subscribe;
  }
  async restore(registered: boolean): Promise<void> {
    if (!registered && this.read().status === "ready" && !this.read().busy) this.state.update(state => ({ ...state, status: "disabled" }));
    if (this.read().status === "disabled" && registered && await this.browser.subscription()) this.state.update(state => ({ ...state, status: "ready" }));
  }
  async enable(): Promise<void> {
    if (this.read().busy || !["disabled", "ready"].includes(this.read().status)) return;
    this.state.update(state => ({ ...state, busy: true, line: undefined }));
    let created = false;
    try {
      // Invoke permission synchronously in the click's user gesture, before waiting for a worker/key.
      if (await this.browser.requestPermission() !== "granted") { this.state.set({ status: "denied", busy: false }); return; }
      let existing = await this.browser.subscription();
      // The environment's current registration survives settings/session changes and page reloads.
      if (existing && !await this.actions.registered()) {
        await this.browser.unsubscribe(existing);
        existing = await this.browser.subscription();
      }
      const subscription = existing ?? await this.browser.subscribe(await this.actions.key());
      created = existing === null;
      await this.actions.set(subscription);
      this.state.set({ status: "ready", busy: false, line: "Push enabled for this client." });
    } catch {
      if (created) await this.browser.unsubscribe().catch(() => undefined);
      this.state.update(state => ({ ...state, busy: false, line: "Could not enable push. Check your connection and browser settings; use the fallback below." }));
    }
  }
  async disable(): Promise<void> {
    if (this.read().busy) return;
    this.state.update(state => ({ ...state, busy: true, line: undefined }));
    try { await this.actions.remove(); await this.browser.unsubscribe(); this.state.set({ status: "disabled", busy: false, line: "Push disabled for this client." }); }
    catch { this.state.update(state => ({ ...state, busy: false, line: "Could not finish disabling push. Retry when connected." })); }
  }
  async useFallback(activate?: () => Promise<void>): Promise<void> {
    if (this.read().busy) return;
    this.state.update(state => ({ ...state, busy: true, line: undefined }));
    try {
      await activate?.();
      if (this.read().status === "ready") { await this.actions.remove(); await this.browser.unsubscribe(); }
      this.state.update(state => ({ ...state, status: state.status === "ready" ? "disabled" : state.status, line: "Using the configured webhook fallback. In-app Parked asks remain available." }));
    } catch { this.state.update(state => ({ ...state, line: "Could not select the fallback. Check its attention status and your connection." })); }
    finally { this.state.update(state => ({ ...state, busy: false })); }
  }
  async test(): Promise<void> {
    if (this.read().busy || this.read().status !== "ready") return;
    this.state.update(state => ({ ...state, busy: true, line: undefined }));
    let retiring = false;
    try {
      const subscription = await this.browser.subscription();
      const status = await this.actions.test();
      if (status === "retire") {
        retiring = true;
        this.state.update(state => ({ ...state, status: "disabled" }));
        if (subscription) await this.browser.unsubscribe(subscription);
      }
      this.state.update(state => ({ ...state, status: status === "retire" ? "disabled" : state.status, line: status === "sent" ? "Test notification sent. Check your notifications." : "Test delivery failed. Enable push again or use the fallback below." }));
    } catch { this.state.update(state => ({ ...state, line: retiring ? "Could not clear the expired subscription. Enable push to retry or use the fallback below." : "Open a session and connect before testing push." })); }
    finally { this.state.update(state => ({ ...state, busy: false })); }
  }
}

export const PushControls = ({ controller, fallback, onFallback }: { readonly controller: PushController; readonly fallback: readonly AttentionTargetStatus[]; readonly onFallback?: (id: string) => void }) => {
  const state = useSyncExternalStore(controller.subscribe, controller.read);
  return <section data-phone-push aria-label="Web Push" className="flex min-w-0 flex-col gap-3 break-words rounded-lg border border-hairline bg-panel p-3 text-base">
    <h2 className="font-semibold">Web Push</h2>
    <p>Get a generic “A session needs you” notification while this client is closed. No prompt, transcript or credentials are sent. Turn on your private network connection when opening the session.</p>
    <p className="text-ink-muted">On iOS and iPadOS 16.4 or later, push needs a Home Screen web app. In Safari, tap Share, Add to Home Screen, then open its icon and Enable push. Pairing storage may be separate from this tab.</p>
    {state.status === "install" && <p role="status">Add this client to your Home Screen and open its icon before enabling push.</p>}
    {state.status === "unavailable" && <p role="status">Push is unavailable. Use HTTPS and a browser with service workers, Push and Notifications enabled.</p>}
    {state.status === "denied" && <p role="status">Permission was refused. Change this site's notification permission in browser or OS settings, then reload to try again.</p>}
    {state.line && <p role="status">{state.line}</p>}
    <div className="flex flex-wrap gap-2">
      {(state.status === "disabled" || state.status === "ready") && <Button className="h-11" title="Enable push" disabled={state.busy} onClick={() => { void controller.enable(); }}>Enable push</Button>}
      {state.status === "ready" && <><Button className="h-11" title="Test push" disabled={state.busy} onClick={() => { void controller.test(); }}>Test push</Button><Button className="h-11" title="Disable push" disabled={state.busy} onClick={() => { void controller.disable(); }}>Disable push</Button></>}
    </div>
    <h3 className="font-semibold">Fallback and in-app attention</h3>
    {fallback.length ? fallback.map(target => <div key={target.id}><p>{target.id} · {target.state}{target.failure ? ` · ${target.failure}` : ""}</p>{onFallback && (!target.global || target.enabled) && <Button className="mt-2 h-11" title={`Use fallback ${target.id}`} disabled={state.busy} onClick={() => onFallback(target.id)}>Use fallback</Button>}</div>) : <p>No webhook fallback is configured. Ask an environment admin to configure and test a named attention endpoint in Attention settings.</p>}
    <p className="text-ink-muted">In-app Parked asks remain available while connected. In-app attention alone cannot alert a closed browser.</p>
  </section>;
};

const browserPush = (): PushBrowser => {
  const registration = async () => {
    const worker = await navigator.serviceWorker.getRegistration("/");
    if (!worker?.active) throw new Error("Worker unavailable.");
    return worker;
  };
  const data = (value: PushSubscription): PushSubscriptionData => {
    const encoded = value.toJSON();
    if (!encoded.endpoint || !encoded.keys?.["auth"] || !encoded.keys["p256dh"]) throw new Error("Subscription unavailable.");
    return { endpoint: encoded.endpoint, keys: { auth: encoded.keys["auth"], p256dh: encoded.keys["p256dh"] } };
  };
  return {
    permission: () => "Notification" in window ? Notification.permission : "default",
    requestPermission: () => Notification.requestPermission(),
    subscription: async () => { const value = await (await registration()).pushManager.getSubscription(); return value ? data(value) : null; },
    subscribe: async key => data(await (await registration()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })),
    unsubscribe: async expected => {
      const value = await (await registration()).pushManager.getSubscription();
      if (!value) return;
      if (expected) {
        const current = data(value);
        if (current.endpoint !== expected.endpoint || current.keys.auth !== expected.keys.auth || current.keys.p256dh !== expected.keys.p256dh) return;
      }
      if (!await value.unsubscribe()) throw new Error("Subscription unavailable.");
    },
  };
};
const ConnectedPush = ({ environmentId, sessionId }: { readonly environmentId: string; readonly sessionId: string | undefined }) => {
  const runtime = useRuntime();
  const answer = useObservable(useMemo(() => runtime.requests.cached(environmentId, "attention.targets.list", {}), [runtime, environmentId]));
  const clientId = useObservable(runtime.connections.list).find(record => record.environmentId === environmentId)?.clientSessionId;
  const id = `push-${clientId ?? "unpaired"}`;
  const controller = useMemo(() => {
    const browser = browserPush();
    const accepted = async (target?: AttentionTargetInput) => {
      const commandId = crypto.randomUUID();
      const result = target ? await runtime.requests.call(environmentId, "attention.targets.set", { commandId, target }) : await runtime.requests.call(environmentId, "attention.targets.remove", { commandId, id });
      if (!result.ok || result.result.receipt.status !== "accepted") throw new Error("Registration failed.");
      runtime.requests.refresh(environmentId, "attention.targets.list", {});
    };
    return new PushController({ secure: window.isSecureContext, supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window, ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1), standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true }, browser, {
      key: async () => { const result = await runtime.requests.call(environmentId, "attention.push.key", {}); if (!result.ok) throw new Error("Key unavailable."); return result.result.publicKey; },
      registered: async () => {
        const result = await runtime.requests.call(environmentId, "attention.targets.list", {});
        if (!result.ok) throw new Error("Registration unavailable.");
        return result.result.targets.some(target => target.id === id && !target.global && target.transport === "push" && target.enabled);
      },
      set: subscription => accepted({ id, transport: "push", enabled: true, completion: false, configuration: { endpoint: subscription.endpoint, ...subscription.keys } }),
      remove: () => accepted(),
      test: async () => { if (!sessionId) throw new Error("Open a session first."); const result = await runtime.requests.call(environmentId, "attention.push.test", { id, sessionId }); if (!result.ok) throw new Error("Test failed."); return result.result.status; },
    });
  }, [runtime, environmentId, sessionId, id]);
  useEffect(() => { void controller.restore(answer.result?.targets.some(target => target.id === id && target.enabled) ?? false).catch(() => undefined); }, [controller, answer.result, id]);
  const fallback = answer.result?.targets.filter(target => target.transport === "webhook") ?? [];
  return <PushControls controller={controller} fallback={answer.result?.targets.filter(target => target.transport === "webhook") ?? []} onFallback={fallbackId => {
    void controller.useFallback(fallback.find(target => target.id === fallbackId)?.global ? undefined : async () => {
      const result = await runtime.requests.call(environmentId, "attention.targets.configure", { commandId: crypto.randomUUID(), id: fallbackId, enabled: true, completion: false });
      if (!result.ok || result.result.receipt.status !== "accepted") throw new Error("Fallback unavailable.");
      runtime.requests.refresh(environmentId, "attention.targets.list", {});
    });
  }} />;
};
const PushSurface = () => {
  const settings = useSettings();
  const picked = usePickedEnvironment();
  const [anchor, setAnchor] = useState<Element | null>(null);
  const [layout] = usePresentation("paneLayout");
  const session = layout.rows.flatMap(row => row.panes).find(pane => pane.id === layout.focused)?.session;
  const records = useObservable(useRuntime().connections.list);
  const home = servingConnection(records, window.location.origin);
  useEffect(() => {
    if (!settings.shown) { setAnchor(null); return; }
    const find = () => setAnchor(document.querySelector("[data-attention-settings]"));
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    find();
    return () => observer.disconnect();
  }, [settings.shown]);
  if (!settings.shown || !anchor) return null;
  return createPortal(home && picked?.environmentId === home.environmentId
    ? <ConnectedPush environmentId={home.environmentId} sessionId={session?.environmentId === home.environmentId ? session.sessionId : undefined} />
    : <p>Manage push from this web origin's environment in Attention settings. Notification links stay on this origin.</p>, anchor);
};
export const webModule: WebModule = { slot: "push", registration: { Surface: PushSurface } };

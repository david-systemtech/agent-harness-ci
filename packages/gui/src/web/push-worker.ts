import { AttentionPayload } from "@agent-harness/contracts";
import type { PushWorkerHook } from "./service-worker.js";

interface PushEvent { readonly data?: { json(): unknown }; waitUntil(pending: Promise<unknown>): void }
interface ClickEvent { readonly notification: { readonly data: unknown; close(): void }; waitUntil(pending: Promise<unknown>): void }
export interface PushWorkerScope {
  readonly location: { readonly origin: string };
  readonly registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  readonly clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly { readonly url: string; focus(): Promise<unknown>; postMessage(message: AttentionOpened): void }[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: ClickEvent) => void): void;
}
/** What the worker tells a window already on a notification's link when it is tapped: nothing reloads, so the page shows the session itself (#1903). */
export interface AttentionOpened { readonly type: "attention-opened"; readonly url: string }
export const isAttentionOpened = (data: unknown): data is AttentionOpened =>
  typeof data === "object" && data !== null && "type" in data && data.type === "attention-opened" && "url" in data && typeof data.url === "string";
const safeLink = (value: unknown, origin: string): string | undefined => {
  if (typeof value !== "string") return undefined;
  const payload = AttentionPayload.safeParse({ message: "A session needs you", url: value });
  return payload.success && new URL(value).origin === origin ? value : undefined;
};
/** No credentials, cached session data, runtime or socket in the worker's push leaf. */
export const installPushWorker = (scope: PushWorkerScope): void => {
  scope.addEventListener("push", event => {
    try {
      const payload = AttentionPayload.safeParse(event.data?.json());
      if (!payload.success || !safeLink(payload.data.url, scope.location.origin)) return;
      event.waitUntil(scope.registration.showNotification(payload.data.message, { data: { url: payload.data.url }, icon: "/phone-icons/icon-192.png", tag: payload.data.url }));
    } catch { /* Untrusted or missing gateway payload is not displayed. */ }
  });
  scope.addEventListener("notificationclick", event => {
    event.notification.close();
    const data = event.notification.data;
    const url = safeLink(typeof data === "object" && data !== null && "url" in data ? data.url : undefined, scope.location.origin);
    if (!url) return;
    event.waitUntil((async () => {
      const existing = (await scope.clients.matchAll({ type: "window", includeUncontrolled: true })).find(client => client.url === url);
      if (existing) { existing.postMessage({ type: "attention-opened", url }); await existing.focus(); }
      else await scope.clients.openWindow(url);
    })());
  });
};
/** P12's exported hook intentionally carries the public-cache scope; this leaf adds push APIs. */
export const pushWorkerHook: PushWorkerHook = scope => installPushWorker(scope as unknown as PushWorkerScope);

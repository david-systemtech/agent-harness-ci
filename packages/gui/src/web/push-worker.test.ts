import { expect, it } from "vitest";
import { installPushWorker, type PushWorkerScope } from "./push-worker.js";

it("a worker with no page displays only the safe payload and opens the waiting same-origin session", async () => {
  const listeners = new Map<string, (event: never) => void>();
  let notification: { title: string; options: NotificationOptions } | undefined;
  const opened: string[] = [];
  const scope: PushWorkerScope = {
    location: { origin: "https://example.test:8443" },
    registration: { showNotification: async (title, options) => { notification = { title, options }; } },
    clients: { openWindow: async url => { opened.push(url); }, matchAll: async () => [] },
    addEventListener: (type, listener) => { listeners.set(type, listener as (event: never) => void); },
  };
  installPushWorker(scope);
  const emit = async (type: string, event: object) => { let work: Promise<unknown> | undefined; listeners.get(type)!({ ...event, waitUntil: (pending: Promise<unknown>) => { work = pending; } } as never); await work; };
  const payload = { message: "A session needs you", url: "https://example.test:8443/#/session/env-1/session-1" };
  await emit("push", { data: { json: () => payload } });
  expect(notification).toEqual({ title: "A session needs you", options: { data: { url: payload.url }, icon: "/phone-icons/icon-192.png", tag: payload.url } });
  await emit("notificationclick", { notification: { data: notification!.options.data, close: () => undefined } });
  expect(opened).toEqual([payload.url]);
  notification = undefined;
  await emit("push", { data: { json: () => ({ ...payload, url: "https://evil.test/#/session/env-1/session-1" }) } });
  expect(notification).toBeUndefined();
  await emit("push", { data: { json: () => ({ ...payload, token: "token-for-tests" }) } });
  expect(notification).toBeUndefined();
  await emit("notificationclick", { notification: { data: { url: "https://evil.test/" }, close: () => undefined } });
  expect(opened).toHaveLength(1);
});

it("a tap on a notification whose session a window already shows focuses that window and tells it the session was opened", async () => {
  const listeners = new Map<string, (event: never) => void>();
  const url = "https://example.test:8443/#/session/env-1/session-1";
  const told: unknown[] = [], opened: string[] = [];
  let focused = 0;
  const scope: PushWorkerScope = {
    location: { origin: "https://example.test:8443" },
    registration: { showNotification: async () => undefined },
    clients: { openWindow: async link => { opened.push(link); }, matchAll: async () => [{ url, focus: async () => { focused += 1; }, postMessage: message => { told.push(message); } }] },
    addEventListener: (type, listener) => { listeners.set(type, listener as (event: never) => void); },
  };
  installPushWorker(scope);
  let work: Promise<unknown> | undefined;
  listeners.get("notificationclick")!({ notification: { data: { url }, close: () => undefined }, waitUntil: (pending: Promise<unknown>) => { work = pending; } } as never);
  await work;
  expect({ told, focused, opened }).toEqual({ told: [{ type: "attention-opened", url }], focused: 1, opened: [] });
});

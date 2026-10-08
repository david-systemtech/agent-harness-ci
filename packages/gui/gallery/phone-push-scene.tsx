import { useMemo } from "react";
import { PushController, PushControls, type PushFeatures } from "../src/web/push.js";
export const phonePushScene = (mode: "ready" | "disabled" | "denied" | "unavailable" | "install") => function PhonePushScene() {
  const controller = useMemo(() => {
    const features: PushFeatures = { secure: true, supported: mode !== "unavailable", ios: mode === "install", standalone: false };
    const instance = new PushController(features, { permission: () => mode === "denied" ? "denied" : "granted", requestPermission: async () => "granted", subscription: async () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { auth: "auth-for-tests", p256dh: "key-for-tests" } }), subscribe: async () => { throw new Error("Gallery has no push gateway."); }, unsubscribe: async () => undefined }, { key: async () => "key-for-tests", registered: async () => mode === "ready", set: async () => undefined, remove: async () => undefined, test: async () => "retry" });
    if (mode === "ready") void instance.restore(true);
    return instance;
  }, []);
  return <main data-phone-push-scene className="mx-auto flex h-dvh min-w-0 max-w-[390px] flex-col bg-abyss p-4 text-ink" style={{ paddingTop: "max(16px,env(safe-area-inset-top))", paddingBottom: "max(16px,env(safe-area-inset-bottom))" }}>
    <h1 className="mb-3 shrink-0 text-base font-semibold">Phone notifications</h1>
    <div className="min-h-0 overflow-y-auto"><PushControls controller={controller} admin={false} onFallback={() => { void controller.useFallback(); }} fallback={[{ id: "configured-fallback", transport: "webhook", enabled: true, completion: false, global: true, state: mode === "unavailable" ? "unavailable" : "ready", failure: null }]} /></div>
  </main>;
};
export const phonePushGeometry = () => [
  { selector: "[data-phone-push-scene]", maxWidth: 390, contentFits: true },
  { selector: "[data-phone-push]", contentFits: true },
  { selector: "[data-phone-push] button", minimumHeight: 44 },
];

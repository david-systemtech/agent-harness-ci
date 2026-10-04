import { useEffect, useMemo } from "react";
import { InstallController, InstallGuidance } from "../src/web/install.js";
import { UpdateController, UpdateNotice } from "../src/web/updates.js";

export const phoneInstallScene = (mode: "install" | "update" | "denial") => function PhoneInstallScene() {
  const events = useMemo(() => new EventTarget(), []);
  const install = useMemo(() => new InstallController(events, { secure: true, standalone: false, ios: mode === "install", worker: mode !== "denial" }), [events]);
  const update = useMemo(() => {
    const controller = new UpdateController(events, async () => undefined, () => undefined);
    if (mode === "update") controller.offer({ postMessage: () => undefined });
    return controller;
  }, [events]);
  useEffect(() => {
    if (mode === "denial") {
      events.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: async () => { throw new DOMException("Denied", "NotAllowedError"); }, userChoice: Promise.resolve({ outcome: "dismissed" }) }));
      void install.install();
    }
    return () => { install.dispose(); update.dispose(); };
  }, [install, update]);
  return <main data-phone-install-scene className="mx-auto flex h-dvh min-w-0 max-w-[390px] flex-col bg-abyss p-4 text-ink" style={{ paddingTop: "max(16px,env(safe-area-inset-top))", paddingBottom: "max(16px,env(safe-area-inset-bottom))" }}>
    <h1 className="mb-3 shrink-0 text-base font-semibold">Home Screen client</h1>
    <div className="min-h-0 flex-1 overflow-y-auto text-base"><InstallGuidance controller={install} /></div>
    <UpdateNotice controller={update} />
  </main>;
};
export const phoneInstallGeometry = (update: boolean) => [
  { selector: "[data-phone-install-scene]", maxWidth: 390, contentFits: true },
  { selector: "[data-phone-install]", contentFits: true },
  ...(update ? [{ selector: "[data-client-update] button", minimumHeight: 44, visibleWithin: "[data-phone-install-scene]" }] : []),
];

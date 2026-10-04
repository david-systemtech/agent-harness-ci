import type { Runtime } from "@agent-harness/client-runtime";
import type { ComponentType } from "react";
import type { BrowserPlatform } from "./browser-platform.js";

/** Each owner adds a leaf module in its named slot; startup wiring stays here. */
export interface WebRegistration {
  readonly start?: (runtime: Runtime, platform: BrowserPlatform) => void | (() => void);
  readonly Surface?: ComponentType;
}
export const WEB_MODULE_SLOTS = ["inputs", "camera", "preview", "browser", "install", "worker", "push", "attention-settings"] as const;
export type WebModuleSlot = (typeof WEB_MODULE_SLOTS)[number];
export interface WebModule { readonly slot: WebModuleSlot; readonly registration: WebRegistration }

const leaves = import.meta.glob<{ readonly webModule: WebModule }>([
  "./web-inputs.ts", "./web-camera.ts", "./web-preview.ts", "./web-browser.ts",
  "../web/install.tsx", "../web/service-worker.ts", "../web/updates.tsx", "../web/push.tsx", "../settings/web-attention.tsx",
], { eager: true });
export const webRegistrations: readonly WebModule[] = Object.values(leaves).map(leaf => leaf.webModule);
export const WebRegisteredSurfaces = () => <>{webRegistrations.map(({ slot, registration }) => {
  const Surface = registration.Surface;
  return Surface ? <Surface key={slot} /> : null;
})}</>;

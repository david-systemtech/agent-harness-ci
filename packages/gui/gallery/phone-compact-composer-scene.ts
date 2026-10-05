import type { SceneGeometry, SceneModule, SceneViewport } from "./scene-registry.js";
import { webModule } from "../src/web/install.js";

export const platform = "web";
export const script: NonNullable<SceneModule["script"]> = (() => ({ environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive", "terminal", "admin"], capabilities: ["workspaceChecks"],
  sessions: [{ title: "Receipt totals", workspace: { kind: "directory", path: "/work/receipts" } }],
}] }))();
export const route: NonNullable<SceneModule["route"]> = world => ({ session: { environmentId: world.environment("desk").environmentId, sessionId: world.environment("desk").sessionId() } });
export const arrangeWeb: NonNullable<SceneModule["arrangeWeb"]> = world => {
  const env = world.environment("desk");
  env.wire.answer("checks.get", () => ({ result: { workspace: "/work/receipts", command: null } }));
  const { runId } = env.startRun(env.sessionId(), "Compare the receipts.");
  env.emit(env.sessionId(), "assistant.text", { runId, itemId: "totals", text: "The receipts match the summary.\n\n".repeat(20), aborted: false });
  env.endRun(env.sessionId(), runId);
};
export const readySelector = '[data-compact-composer-proof="passed"]';
export const geometry = ({ width, height }: SceneViewport): readonly SceneGeometry[] => [
  { selector: "[data-web-client]", contentFits: true },
  { selector: "[data-phone-composer-toolbar]", height: 48, visibleWithin: "[data-web-client]", contentFits: true },
  { selector: "[data-phone-composer-toolbar] button", minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Send"], [aria-label="Attach files"]', minimumHeight: 44, minimumWidth: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" },
  { selector: '[aria-label="Transcript"]', minimumHeight: height >= 480 ? 84 : 44, visibleWithin: "[data-web-client]" },
  ...(width === 390 && height === 844 ? [{ selector: "[data-composer-column]", maxHeight: 169 }] : []),
];

/** The hosted browser proves the actual bottom edge and space returned to the transcript. */
export const compactComposer = (inset: number, standalone: boolean) => () => {
  const root = document.documentElement;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "standalone");
  Object.defineProperty(navigator, "standalone", { configurable: true, value: standalone });
  const stopInstall = webModule.registration.start();
  for (const edge of ["top", "right", "bottom", "left"]) root.style.setProperty(`--phone-frame-safe-${edge}`, `${edge === "bottom" ? inset : 0}px`);
  let stopped = false;
  const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const observer = new MutationObserver(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
    if (!field || !document.querySelector('[aria-label="Workspace: receipts"]')) return;
    observer.disconnect();
    void (async () => {
      await document.fonts.ready;
      if (innerHeight === 480) field.focus();
      await settle();
      if (stopped) return;
      const frame = document.querySelector<HTMLElement>("[data-web-client]")!;
      const dock = document.querySelector<HTMLElement>("[data-composer-column]")!;
      const card = document.querySelector<HTMLElement>("[data-composer-card]")!;
      const transcript = document.querySelector<HTMLElement>('[aria-label="Transcript"]')!;
      const bottom = frame.getBoundingClientRect().bottom - inset;
      for (const element of [dock, card]) {
        if (Math.abs(element.getBoundingClientRect().bottom - bottom) > 1) throw new Error("Compact composer does not reach the safe-area edge");
      }
      if (innerHeight >= 480 && transcript.clientHeight < 3 * parseFloat(getComputedStyle(transcript).lineHeight)) throw new Error("Compact composer leaves fewer than three transcript lines");
      if (document.documentElement.scrollWidth > innerWidth || window.scrollY !== 0) throw new Error("Compact composer overflows the page");
      frame.setAttribute("data-compact-composer-proof", "passed");
    })().catch(error => {
      if (stopped) return;
      document.querySelector("[data-web-client]")?.setAttribute("data-compact-composer-proof", "failed");
      queueMicrotask(() => { throw error; });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  return () => {
    stopped = true; observer.disconnect(); stopInstall();
    for (const edge of ["top", "right", "bottom", "left"]) root.style.removeProperty(`--phone-frame-safe-${edge}`);
    if (descriptor) Object.defineProperty(navigator, "standalone", descriptor);
    else delete (navigator as Navigator & { standalone?: boolean }).standalone;
  };
};

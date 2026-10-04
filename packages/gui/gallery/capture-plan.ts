import { readdir } from "node:fs/promises";
import { captureName } from "./compare.js";
import { sceneName } from "./scene-registry.js";

/** Read filenames only: component modules are renderer code, never Node capture dependencies. */
export async function sceneFiles(directory: string): Promise<readonly string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((file) => file.isFile() && file.name.endsWith(".tsx"))
    .map((file) => sceneName(file.name)).sort();
}

/** look.md §16 names the light subset; every other scene still gets the dark ladder. */
export function captureCases(scenes: readonly string[]) {
  const light = (scene: string) => /^(window-empty|window-not-ready|window-start-failed|primitives|session-conversation|session-tools|dock-diff|prompt-.*|composer-.*|status-line|context-usage|run-picker.*|palette-.*|dialogs|dialog-.*|notices|settings-accounts|settings-permissions|settings-theme|setup-introduction.*|setup-account|setup-appearance|setup-close-confirmation)$/.test(scene);
  return scenes.filter(scene => !scene.startsWith("phone-")).flatMap((scene) => (light(scene) ? ["light", "dark"] as const : ["dark"] as const).map((ladder) => ({ scene, ladder, name: `${scene}.${ladder}` })));
}

export const PHONE_PROFILES = [
  { suffix: "phone-390", viewport: { width: 390, height: 844 }, textSize: 14 },
  { suffix: "phone-360", viewport: { width: 360, height: 740 }, textSize: 14 },
  { suffix: "phone-390-text-20", viewport: { width: 390, height: 844 }, textSize: 20 },
  // A reduced visual viewport exercises the keyboard layout without an OS keyboard.
  { suffix: "phone-390-keyboard", viewport: { width: 390, height: 480 }, textSize: 14 },
] as const;

export interface CaptureCase {
  readonly scene: string;
  readonly ladder: "light" | "dark";
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly textSize: number;
  readonly platform: "desktop" | "web";
}

/** Phone owners opt in with phone-* scene files; existing desktop names and ladders stay intact. */
function allCaptures(scenes: readonly string[]): readonly CaptureCase[] {
  const desktop: CaptureCase[] = ([{ width: 1400, height: 900 }, { width: 1024, height: 768 }] as const).flatMap(viewport =>
    captureCases(scenes).map(({ scene, ladder }) => ({
      scene, ladder, viewport, name: captureName(scene, viewport.width, ladder), textSize: 14, platform: "desktop",
    })),
  );
  const phone: CaptureCase[] = scenes.filter(scene => scene.startsWith("phone-")).flatMap(scene =>
    // Continue uses the same full-width footer at both widths; keep its 390, text and keyboard cases.
    PHONE_PROFILES.filter(profile => scene !== "phone-gallery-continue" || profile.suffix !== "phone-360").flatMap(({ suffix, viewport, textSize }) => (["light", "dark"] as const).map(ladder => ({
      scene, ladder, viewport, textSize, platform: "web", name: `${scene}-${suffix}.${ladder}`,
    }))),
  );
  const captures = [...desktop, ...phone];
  if (new Set(captures.map(c => c.name)).size !== captures.length) throw new Error("Duplicate gallery capture name.");
  return captures;
}

function boundedPlan(captures: readonly CaptureCase[]) {
  const desktop = captures.filter(capture => capture.platform === "desktop").length;
  const phone = captures.length - desktop;
  const budget = { desktop, phone, total: captures.length, limit: 400, remaining: 400 - captures.length };
  if (budget.remaining < 0) throw new Error(`Gallery capture budget exceeded: ${budget.desktop} desktop + ${budget.phone} phone > ${budget.limit}. Shard publication and acceptance together before adding scenes.`);
  return { captures, budget };
}

/** Every report retains the publisher and acceptance limits; no existing capture is dropped. */
export function captureShards(scenes: readonly string[]) {
  const captures = allCaptures(scenes);
  if (captures.length > 800) throw new Error("Gallery capture budget exceeded: at most two bounded reports are supported.");
  return Array.from({ length: Math.ceil(captures.length / 400) }, (_, index) => boundedPlan(captures.slice(index * 400, (index + 1) * 400)));
}
export function capturePlan(scenes: readonly string[]) { return boundedPlan(allCaptures(scenes)); }

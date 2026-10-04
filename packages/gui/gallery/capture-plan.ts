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
export function capturePlan(scenes: readonly string[]) {
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
  const count = Math.ceil(captures.length / 400);
  const limit = count * 400;
  const budget = { desktop: desktop.length, phone: phone.length, total: captures.length, limit, remaining: limit - captures.length };
  if (count > 16) throw new Error(`Gallery capture budget exceeded: ${budget.desktop} desktop + ${budget.phone} phone > 6400 (sixteen reports).`);
  const shards = Array.from({ length: count }, (_, index) => ({
    index: index + 1, count, total: captures.length, captures: captures.slice(index * 400, (index + 1) * 400),
  }));
  return { captures, budget, shards };
}

/** Single-report jobs remain valid while the hosted workflow rolls out shard selection. */
export function captureShard(plan: ReturnType<typeof capturePlan>, selection: string | undefined, run: string | undefined) {
  const index = selection === undefined && plan.shards.length === 1 ? 1 : Number(selection);
  const selected = plan.shards.find(shard => shard.index === index);
  if (selected === undefined || run === undefined || !/^[A-Za-z0-9._-]{1,128}$/.test(run)) throw new Error("Invalid gallery shard selection.");
  return { ...selected, shard: { run, index: selected.index, count: selected.count, total: selected.total } };
}

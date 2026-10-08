import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { LANDSCAPE_PHONE_PROFILES } from "./phone-landscape-profiles.js";
import { COMPACT_COMPOSER_PROFILES } from "./phone-compact-composer-profiles.js";
import { captureName } from "./compare.js";
import { sceneName } from "./scene-registry.js";

const limits = JSON.parse(readFileSync(new URL("../../../scripts/gallery-allocation.json", import.meta.url), "utf8")) as { desktop: number; phone: number };

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

/**
 * Laptop windows shorter than the standard captures, where a dialog's header and footer must stay in the
 * window (look.md §11.1; #1690 measured the sign-in dialog off-screen at 1280 × 800 and 1280 × 700). The
 * scene is mounted again in each and its geometry measured without a screenshot, so the published captures
 * keep their two sizes; the probes run once per scene, with its wide dark capture. The header's breadcrumb
 * is measured there too, where #1790 saw a scratch folder's identifier squeeze the session title, and the
 * status line beside a docked side pane, where #1892 saw a session column of about 640px cut the run's spend.
 */
export const LAPTOP_PROBES = [{ width: 1280, height: 800 }, { width: 1280, height: 700 }] as const;
const LAPTOP_SCENES: ReadonlySet<string> = new Set(["dialog-sign-in", "window-session", "status-line-docked"]);

export interface CaptureCase {
  readonly scene: string;
  readonly ladder: "light" | "dark";
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly textSize: number;
  readonly platform: "desktop" | "web";
  /** Further windows in which the scene's geometry is measured, without a capture. */
  readonly probes?: readonly { readonly width: number; readonly height: number }[];
}

/** Phone owners opt in with phone-* scene files; existing desktop names and ladders stay intact. */
export function capturePlan(scenes: readonly string[]) {
  const desktop: CaptureCase[] = ([{ width: 1400, height: 900 }, { width: 1024, height: 768 }] as const).flatMap(viewport =>
    captureCases(scenes).map(({ scene, ladder }) => ({
      scene, ladder, viewport, name: captureName(scene, viewport.width, ladder), textSize: 14, platform: "desktop",
      ...(LAPTOP_SCENES.has(scene) && ladder === "dark" && viewport.width === 1400 && { probes: LAPTOP_PROBES }),
    })),
  );
  const phone: CaptureCase[] = scenes.filter(scene => scene.startsWith("phone-")).flatMap(scene =>
    // Surface scenes carry the full matrix; scaffold and duplicate keyboard scenes keep one proof.
    (scene.startsWith("phone-landscape-") ? LANDSCAPE_PHONE_PROFILES : scene.startsWith("phone-compact-composer-") ? COMPACT_COMPOSER_PROFILES : PHONE_PROFILES).filter(profile => {
      if (scene === "phone-keyboard-dock") return profile.suffix === "phone-390";
      if (scene === "phone-gallery-conversation") return profile.suffix === "phone-390";
      if (scene === "phone-pairing-unlisted-origin") return profile.suffix === "phone-390";
      if (scene === "phone-gallery-permission" || scene === "phone-gallery-continue" || scene === "phone-attention-keyboard" || scene === "phone-layout-keyboard") return profile.suffix === "phone-390-keyboard";
      if (scene === "phone-attention-pending") return profile.suffix !== "phone-390-keyboard";
      return true;
    }).flatMap(({ suffix, viewport, textSize }) => (["light", "dark"] as const).map(ladder => ({
      scene, ladder, viewport, textSize, platform: "web", name: `${scene}-${suffix}.${ladder}`,
    }))),
  );
  const captures = [...desktop, ...phone];
  if (new Set(captures.map(c => c.name)).size !== captures.length) throw new Error("Duplicate gallery capture name.");
  const shards = ([{ kind: "desktop", captures: desktop, limit: limits.desktop }, { kind: "phone", captures: phone, limit: limits.phone }] as const).flatMap(group => {
    if (!Number.isInteger(group.limit) || group.limit < 1 || group.limit > 400) throw new Error("Invalid gallery report limit.");
    const result = [];
    for (let offset = 0; offset < group.captures.length; offset += group.limit) {
      const captures = group.captures.slice(offset, offset + group.limit);
      result.push({ id: `${group.kind}-${String(offset / group.limit + 1).padStart(3, "0")}`, captures,
        budget: { desktop: group.kind === "desktop" ? captures.length : 0, phone: group.kind === "phone" ? captures.length : 0,
          total: captures.length, limit: group.limit, remaining: group.limit - captures.length } });
    }
    return result;
  });
  if (shards.length > 100) throw new Error("Gallery shard count exceeds the hosted artifact listing limit.");
  const limit = shards.reduce((total, shard) => total + shard.budget.limit, 0);
  const budget = { desktop: desktop.length, phone: phone.length, total: captures.length, limit, remaining: limit - captures.length };
  return { captures, budget, shards };
}

/** Explicit selection keeps local capture and hosted jobs on the same bounded report. */
export function captureShard(plan: ReturnType<typeof capturePlan>, selection: string | undefined) {
  const selected = plan.shards.find(shard => shard.id === selection);
  if (selected === undefined) throw new Error("Invalid gallery shard selection.");
  return { ...selected, shard: { id: selected.id, index: plan.shards.indexOf(selected), count: plan.shards.length } };
}

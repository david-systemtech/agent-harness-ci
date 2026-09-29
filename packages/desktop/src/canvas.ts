import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_THEME } from "@agent-harness/contracts";
import { derive, windowBackground } from "@agent-harness/theme";

/**
 * The colour the window opens on, before any CSS has loaded (ADR 0023): the
 * last Canvas colour the renderer set (`window.setBackgroundColour`), kept in
 * the desktop's data directory, and on first launch the preset theme's
 * Canvas, never the OS's window colour.
 */

const CANVAS_FILE = "window.json";

/** `#rrggbb`, as the theme package's `windowBackground` gives a Canvas. */
export const isCanvasColour = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

/**
 * The preset theme's Canvas in the ladder the OS prefers, as the renderer's
 * first frame paints it before it reads a theme (docs/specs/gui.md, chosen
 * defaults), so the window's colour and the page's match.
 */
export const presetCanvas = (osPrefersDark: boolean): string => windowBackground(derive(DEFAULT_THEME)[osPrefersDark ? "dark" : "light"]);

export const canvasStore = (dataDir: string) => {
  const file = join(dataDir, CANVAS_FILE);
  return {
    /** The last colour set; undefined on first launch, or when what was kept is not a colour. */
    async read(): Promise<string | undefined> {
      try {
        const kept = (JSON.parse(await readFile(file, "utf8")) as { readonly canvas?: unknown } | null)?.canvas;
        return isCanvasColour(kept) ? kept : undefined;
      } catch {
        return undefined;
      }
    },
    /** Keeps `colour` for the next launch: written whole and renamed into place, so a crash leaves the last colour or this one. */
    write(colour: string): void {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(`${file}.next`, `${JSON.stringify({ canvas: colour })}\n`);
      renameSync(`${file}.next`, file);
    },
  };
};
export type CanvasStore = ReturnType<typeof canvasStore>;

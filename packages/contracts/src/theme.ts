import { z } from "zod";

/**
 * A theme (ADR 0023): a name and seven seeds, each one OKLCH hue and chroma.
 * Every colour a window paints is a token the theme package derives from
 * them, in a light and a dark ladder; the lightness of each token is the
 * derivation's, so a seed carries no lightness. A theme file is this shape
 * as JSON, and `appearance.theme` holds it.
 */

/** The seven seeds: the neutral base, the accent, the two activity roles and the three statuses. */
export const THEME_SEED_NAMES = ["canvas", "accent", "machine", "thinking", "success", "warning", "danger"] as const;
export type ThemeSeedName = (typeof THEME_SEED_NAMES)[number];

/** The most chroma a seed may carry: already past every sRGB colour (magenta, the most chromatic, is about 0.32), so the derivation clamps it in. */
export const MAX_SEED_CHROMA = 0.4;

/** A theme's name: 1 to 40 characters counted as code points, on one line, with no control or format character and no white space at either end. */
export const ThemeName = z
  .string()
  // The first and last characters are neither white space, control nor format; those between are neither control, format, nor a line or paragraph separator (Zl, Zp: white space that is not a control character). With the `u` flag the cap counts code points.
  .regex(/^[^\s\p{Cc}\p{Cf}](?:[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{0,38}[^\s\p{Cc}\p{Cf}])?$/u)
  .meta({
    description: "A theme's name: 1 to 40 characters counted as code points, on one line, with no control or format character and no white space at either end.",
  });
export type ThemeName = z.infer<typeof ThemeName>;

/** One seed: an OKLCH hue in degrees, and a chroma. */
export const ThemeSeed = z
  .object({
    hue: z.number().min(0).lt(360).meta({ description: "The OKLCH hue in degrees, from 0 up to but not including 360." }),
    chroma: z.number().min(0).max(MAX_SEED_CHROMA).meta({ description: `The OKLCH chroma, from 0 (grey) to ${MAX_SEED_CHROMA}.` }),
  })
  .meta({
    description:
      "One seed of a theme: an OKLCH hue and chroma. The theme package gives each token its lightness, keeps the chroma inside sRGB and the contrast rules, and reports the seed when it had to clamp it.",
  });
export type ThemeSeed = z.infer<typeof ThemeSeed>;

const role = (description: string) => ThemeSeed.meta({ description });

export const Theme = z
  .object({
    name: ThemeName,
    seeds: z.object({
      canvas: role("The neutral base: the window's ground and every surface, hairline and edge drawn from it."),
      accent: role("The accent: fills, focus rings, selection and links; the one colour that means act."),
      machine: role("Tool and terminal activity."),
      thinking: role("The model's thinking and plans."),
      success: role("The success status."),
      warning: role("The warning status, and what waits on the person."),
      danger: role("The danger status: errors and denials."),
    }),
  })
  .meta({
    description:
      "A theme: a name and seven seeds (canvas, accent, machine, thinking, success, warning, danger), each an OKLCH hue and chroma. Every colour a client paints is a token derived from them, in a light and a dark ladder; a theme file is this shape as JSON.",
  });
export type Theme = z.infer<typeof Theme>;

const seed = (hue: number, chroma: number): ThemeSeed => Object.freeze({ hue, chroma });

/**
 * The preset, "Default": a neutral canvas and a blue-violet accent, with
 * the activity and status hues apart from it and from each other; each
 * chroma is the dark ladder's, so a fresh install paints the palette the
 * surfaces port audit records.
 */
export const DEFAULT_THEME: Theme = Object.freeze({
  name: "Default",
  seeds: Object.freeze({
    canvas: seed(0, 0),
    accent: seed(264, 0.21),
    machine: seed(210, 0.1),
    thinking: seed(310, 0.035),
    success: seed(150, 0.17),
    warning: seed(85, 0.155),
    danger: seed(25, 0.18),
  }),
});

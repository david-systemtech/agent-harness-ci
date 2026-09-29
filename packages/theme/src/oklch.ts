/**
 * OKLCH to sRGB and WCAG 2 contrast: the three measurements the rules are
 * made of (gamut, contrast, hue apart), and the two ways a colour is
 * written out (CSS, and sRGB hex for what cannot read CSS: a window's
 * background, a truecolour terminal).
 *
 * The conversion is the standard one, OKLCH to OKLab to linear sRGB by
 * Björn Ottosson's matrices, and is deliberately not clamped: a component
 * outside 0 to 1 is how a colour out of gamut shows.
 */

/** A colour as the stylesheet writes it: lightness in percent (52, not 0.52), chroma, hue in degrees, and an alpha below 1 for a wash. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha?: number;
}

/** Linear-light sRGB, unclamped. */
const toLinearSrgb = ({ l, c, h }: Oklch): [number, number, number] => {
  const radians = (h * Math.PI) / 180;
  const L = l / 100;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const long = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The colour `amount` of the way from `from` to `to`, mixed in OKLab (the
 * lightness and the two opponent axes each), as a CSS `color-mix(in oklab,
 * ...)` of the two opaque colours would give it.
 */
export const mixOklab = (from: Oklch, to: Oklch, amount: number): Oklch => {
  const axes = ({ c, h }: Oklch) => [c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)] as const;
  const [fromA, fromB] = axes(from);
  const [toA, toB] = axes(to);
  const a = fromA + (toA - fromA) * amount;
  const b = fromB + (toB - fromB) * amount;
  const c = Math.hypot(a, b);
  return { l: from.l + (to.l - from.l) * amount, c, h: c === 0 ? from.h : (((Math.atan2(b, a) * 180) / Math.PI) % 360 + 360) % 360 };
};

/** Whether an sRGB screen can show the colour. The epsilon absorbs floating-point noise at the boundary (white lands a few ulps above 1). */
export const inGamut = (colour: Oklch): boolean => toLinearSrgb(colour).every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** WCAG 2 relative luminance of what the screen shows: clamped, since `inGamut` is what reports a colour out of gamut. */
const luminance = (colour: Oklch): number => {
  const [r, g, b] = toLinearSrgb(colour).map(clamp01) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 2 contrast ratio, 1 (the same) to 21 (black on white), either way round. */
export const contrastRatio = (a: Oklch, b: Oklch): number => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
};

/** How far apart two hues are the short way round, 0 to 180 degrees. */
export const hueDistance = (a: number, b: number): number => {
  const apart = Math.abs(a - b) % 360;
  return apart > 180 ? 360 - apart : apart;
};

/** The sRGB transfer function on one clamped linear component, as a byte. */
const byte = (linear: number): number => {
  const v = clamp01(linear);
  return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
};

/** The colour as `#rrggbb`, its alpha dropped: for a window background or a truecolour terminal, which read no CSS. */
export const toHex = (colour: Oklch): string =>
  `#${toLinearSrgb(colour)
    .map((v) => byte(v).toString(16).padStart(2, "0"))
    .join("")}`;

const written = (value: number, places: number): string => String(Number(value.toFixed(places)));

/** The colour as CSS: `oklch(52% 0.21 264)`, or `oklch(96% 0 0 / 0.07)` for a wash. */
export const cssColour = (colour: Oklch): string => {
  const alpha = colour.alpha === undefined || colour.alpha >= 1 ? "" : ` / ${written(colour.alpha, 3)}`;
  return `oklch(${written(colour.l, 2)}% ${written(colour.c, 4)} ${written(colour.h, 2)}${alpha})`;
};

/** An `oklch()` as the stylesheet writes it (`cssColour`), read back; undefined for anything else. */
export const readCssColour = (text: string): Oklch | undefined => {
  const match = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(text.trim());
  if (match === null) return undefined;
  const [, l, c, h, alpha] = match.map(Number) as [number, number, number, number, number];
  return { l, c, h, ...(match[4] !== undefined && { alpha }) };
};

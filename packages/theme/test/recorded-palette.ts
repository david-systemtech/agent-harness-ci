/**
 * The palette the surfaces port audit records: every token of the token
 * stylesheet it pins, transcribed from the dark (`:root`) and light
 * (`.light`) blocks as written there. The five washes are declared there as
 * `color-mix(in srgb, var(--ink) 7%, transparent)` and the like, which is
 * that token at that alpha. The preset, "Default", must derive these within
 * rounding.
 */

interface Recorded {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha?: number;
}

const o = (l: number, c: number, h: number): Recorded => ({ l, c, h });
const washOf = (colour: Recorded, alpha: number): Recorded => ({ ...colour, alpha });

const washes = (ink: Recorded, beam: Recorded) => ({
  hairline: washOf(ink, 0.07),
  "hairline-strong": washOf(ink, 0.12),
  wash: washOf(ink, 0.035),
  "wash-strong": washOf(ink, 0.08),
  "wash-user": washOf(beam, 0.24),
});

const darkInk = o(96, 0, 0);
const darkBeam = o(52, 0.21, 264);
const lightInk = o(22, 0, 0);
const lightBeam = o(48, 0.19, 264);

export const RECORDED_PALETTE = {
  dark: {
    abyss: o(15.5, 0, 0),
    inset: o(17, 0, 0),
    panel: o(19.5, 0, 0),
    raised: o(22.5, 0, 0),
    float: o(25, 0, 0),
    scrim: o(0, 0, 0),
    line: o(33.5, 0, 0),
    "line-strong": o(56.5, 0, 0),
    ink: darkInk,
    "ink-muted": o(77, 0, 0),
    "ink-faint": o(62, 0, 0),
    beam: darkBeam,
    "beam-dim": o(44, 0.178, 264),
    "beam-ink": o(97, 0.014, 264),
    "beam-text": o(61.5, 0.14, 264),
    cyan: o(80, 0.1, 210),
    sage: o(64, 0.035, 310),
    mint: o(84, 0.17, 150),
    amber: o(85, 0.155, 85),
    "amber-ink": o(18, 0.035, 85),
    signal: o(70, 0.18, 25),
    "signal-ink": o(16, 0.03, 25),
    ...washes(darkInk, darkBeam),
  },
  light: {
    abyss: o(96.5, 0, 0),
    inset: o(95.5, 0, 0),
    panel: o(100, 0, 0),
    raised: o(94, 0, 0),
    float: o(100, 0, 0),
    scrim: o(0, 0, 0),
    line: o(89, 0, 0),
    "line-strong": o(64, 0, 0),
    ink: lightInk,
    "ink-muted": o(43, 0, 0),
    "ink-faint": o(52, 0, 0),
    beam: lightBeam,
    "beam-dim": o(40, 0.161, 264),
    "beam-ink": o(98, 0.005, 264),
    "beam-text": o(48, 0.19, 264),
    cyan: o(48, 0.08, 210),
    sage: o(50, 0.03, 310),
    mint: o(50, 0.13, 150),
    amber: o(50, 0.098, 85),
    "amber-ink": o(98, 0.005, 85),
    signal: o(52, 0.19, 25),
    "signal-ink": o(98, 0.005, 25),
    ...washes(lightInk, lightBeam),
  },
} as const;

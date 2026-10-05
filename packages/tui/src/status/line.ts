import { MODE_BADGE_WORDS, containmentWords, pressureOf, meterReadingsOf as readingsOfGauge, type Pressure, type UsageGauge } from "@agent-harness/client-runtime";
import type { ContainmentLevel, Mode, UsageWindow } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";

/**
 * How the status line draws its words in a terminal (docs/specs/tui.md,
 * "Status, usage, pickers"): the colours and the bars of cells. The words
 * themselves are the client runtime's (`status/words.ts`, #402), which both
 * renderers say.
 */

/** A piece of a line drawn in one style. */
export interface Styled {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/** The mode's badge in its colour: bypassPermissions shouts in red, the one reading on the line that is a warning rather than a setting. */
export const MODE_BADGES: Readonly<Record<Mode, Styled>> = {
  plan: { text: MODE_BADGE_WORDS.plan, color: TERMINAL_ROLES.machine },
  acceptEdits: { text: MODE_BADGE_WORDS.acceptEdits, color: TERMINAL_ROLES.success },
  auto: { text: MODE_BADGE_WORDS.auto },
  bypassPermissions: { text: MODE_BADGE_WORDS.bypassPermissions, color: TERMINAL_ROLES.danger, bold: true },
};

/** The containment level's glyph and word, `off` in yellow, since nothing holds a run in. */
export const containmentBadge = (level: ContainmentLevel, isDefault: boolean): Styled => ({
  text: containmentWords(level, isDefault),
  ...(level === "off" && { color: TERMINAL_ROLES.warning }),
});

/**
 * A window's fullness as a bar: any use lights the
 * first cell, so a started window never reads untouched, and the last cell
 * is held back until the window is full.
 */
export const meterBar = (utilisation: number, cells: number): string => {
  if (cells <= 0) return "";
  const percent = utilisation * 100;
  const exact = Math.round((percent / 100) * cells);
  const floor = percent > 0 ? 1 : 0;
  const ceiling = percent >= 100 ? cells : cells - 1;
  const filled = Math.max(floor, Math.min(exact, ceiling));
  return "█".repeat(filled) + "░".repeat(cells - filled);
};

/** How many cells each bar gets on a line `columns` wide, or none. */
export const meterCells = (columns: number): number => (columns >= 118 ? 5 : columns >= 98 ? 4 : 0);

/** A pressure's colour: red when high or out, yellow when raised, green when low. */
const PRESSURE_COLOURS: Readonly<Record<Pressure, string>> = { out: TERMINAL_ROLES.danger, high: TERMINAL_ROLES.danger, raised: TERMINAL_ROLES.warning, low: TERMINAL_ROLES.success };

/** Colour by pressure, the desktop's thresholds (red at 90%, yellow at 75%); a window the provider refuses is red whatever it reads. */
export const meterTone = (window: Pick<UsageWindow, "utilisation" | "verdict">): string | undefined => {
  const pressure = pressureOf(window);
  return pressure === undefined ? undefined : PRESSURE_COLOURS[pressure];
};

/** One window as the meter draws it: its label, the bar, the percent, `out` when the provider refuses it. */
export interface Reading {
  readonly label: string;
  readonly bar: string;
  readonly value: string;
  readonly tone: string | undefined;
}

export const readingsOf = (gauge: UsageGauge | undefined, cells: number): readonly Reading[] =>
  readingsOfGauge(gauge).map((reading) => ({
    label: reading.label,
    bar: reading.utilisation === null ? "" : meterBar(reading.utilisation, cells),
    value: reading.value,
    tone: reading.pressure === undefined ? undefined : PRESSURE_COLOURS[reading.pressure],
  }));

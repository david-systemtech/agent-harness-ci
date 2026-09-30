import type { Pressure, Reading } from "@agent-harness/client-runtime";
import { classes } from "../ui/classes.js";

/** A window's bar and percent by its pressure: out and high in the danger colour, raised in the warning's, low in success's. */
const BAR_TONES: Readonly<Record<Pressure, string>> = { out: "bg-signal", high: "bg-signal", raised: "bg-amber", low: "bg-sage" };
const VALUE_TONES: Readonly<Record<Pressure, string>> = { out: "font-semibold text-signal", high: "font-semibold text-signal", raised: "text-amber", low: "text-ink-muted" };

/** How much of a bar a window lights, in percent: some for any use, and all only when the window is full. */
const barWidth = (utilisation: number): number => {
  const percent = utilisation * 100;
  if (percent <= 0) return 0;
  if (percent >= 100) return 100;
  return Math.min(Math.max(percent, 8), 92);
};

/**
 * One plan window's bar, lit for any use and full only when the window is,
 * then its percent, `out` when the provider refuses it, each in its
 * pressure's colour: the status line's gauge and the Usage pane draw it.
 */
export const WindowReading = ({ reading }: { readonly reading: Reading }) => (
  <>
    {reading.utilisation !== null && (
      <span aria-hidden="true" className="h-1.5 w-10 overflow-hidden rounded-full bg-wash-strong">
        <span className={classes("block h-full", reading.pressure === undefined ? "bg-ink-faint" : BAR_TONES[reading.pressure])} style={{ width: `${barWidth(reading.utilisation)}%` }} />
      </span>
    )}
    <span className={reading.pressure === undefined ? "text-ink-faint" : VALUE_TONES[reading.pressure]}>{reading.value}</span>
  </>
);

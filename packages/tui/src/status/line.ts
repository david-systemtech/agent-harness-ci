import type { SessionProjection, UsageGauge } from "@agent-harness/client-runtime";
import type { ContainmentLevel, HandoffRecommendation, Mode, ModelUsage, UsageWindow } from "@agent-harness/contracts";
import { classifyTool, describeActivity, type ActivityCounts, type ToolCategory } from "../transcript/format.js";

/**
 * What the status line says, as words and colours (docs/specs/tui.md,
 * "Status, usage, pickers"): pure, so the component is colours
 * and boxes. Line one is what the next message goes out as; line two what
 * the run is doing, or the hand-off offer.
 */

/** A piece of a line drawn in one style. */
export interface Styled {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/**
 * The mode as a badge: `⏵⏵` for the modes that do
 * not stop to ask, `⏸` for those that do; bypassPermissions shouts in red,
 * the one reading on the line that is a warning rather than a setting.
 */
export const MODE_BADGES: Readonly<Record<Mode, Styled>> = {
  plan: { text: "⏸ plan", color: "cyan" },
  acceptEdits: { text: "⏵⏵ accept edits", color: "green" },
  auto: { text: "⏸ auto" },
  bypassPermissions: { text: "⏵⏵ BYPASS", color: "red", bold: true },
};

/**
 * The containment level as a glyph and its word: the fuller the circle, the
 * less a run may reach; `off` in yellow, since nothing holds a run in.
 * `default` marks a level read from the environment's default rather than
 * the session's own (the session's own is on no summary, so a terminal knows
 * it only from its own `permissions.containment.set`).
 */
export const containmentBadge = (level: ContainmentLevel, isDefault: boolean): Styled => {
  const glyph = level === "off" ? "○ off" : level === "workspace" ? "◐ workspace" : "● no network";
  return { text: isDefault ? `${glyph} (default)` : glyph, ...(level === "off" && { color: "yellow" }) };
};

/** A plan window's short name, as the meter draws it: `5hr`, `Week`, a model's own bucket by its name. */
export const windowLabel = (window: string): string => {
  if (window === "five_hour") return "5hr";
  if (window === "seven_day") return "Week";
  if (window.startsWith("model_scoped:")) {
    const model = window.slice("model_scoped:".length);
    return model.charAt(0).toUpperCase() + model.slice(1);
  }
  return window.replace(/_/g, " ");
};

/** A plan window's name in a sentence or a list: `5-hour`, `Week`, a model's bucket. */
export const windowWords = (window: string): string => (window === "five_hour" ? "5-hour" : windowLabel(window));

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

/** Colour by pressure, the desktop's thresholds (red at 90%, yellow at 75%); a window the provider refuses is red whatever it reads. */
export const meterTone = (window: Pick<UsageWindow, "utilisation" | "verdict">): string | undefined => {
  if (window.verdict === "rejected") return "red";
  if (window.utilisation === null) return undefined;
  if (window.utilisation >= 0.9) return "red";
  if (window.utilisation >= 0.75) return "yellow";
  return "green";
};

/** A fraction as a whole percent: `42%`; `—` when the provider does not say. */
export const percent = (utilisation: number | null): string => (utilisation === null ? "—" : `${Math.round(utilisation * 100)}%`);

/** One window as the meter draws it: its label, the bar, the percent, `out` when the provider refuses it. */
export interface Reading {
  readonly label: string;
  readonly bar: string;
  readonly value: string;
  readonly tone: string | undefined;
}

export const readingsOf = (gauge: UsageGauge | undefined, cells: number): readonly Reading[] =>
  (gauge?.windows ?? []).map((window) => ({
    label: windowLabel(window.window),
    bar: window.utilisation === null ? "" : meterBar(window.utilisation, cells),
    value: window.verdict === "rejected" ? `${percent(window.utilisation)} out` : percent(window.utilisation),
    tone: meterTone(window),
  }));

/** A gauge's windows in one line, with no bars: `5hr 42% · Week 10%`; its reason when it has none. */
export const readingWords = (gauge: UsageGauge | undefined): string | undefined => {
  if (!gauge) return undefined;
  if (gauge.windows.length === 0) return gauge.unavailableReason ?? undefined;
  return readingsOf(gauge, 0)
    .map((reading) => `${reading.label} ${reading.value}`)
    .join(" · ");
};

/**
 * Elapsed time on a line that redraws once a second: zero-padded past the
 * first minute so the field holds its width.
 */
export const elapsedClock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (total < 60) return `${seconds}s`;
  if (hours === 0) return `${minutes}m ${pad(seconds)}s`;
  return `${hours}h ${pad(minutes)}m`;
};

/** A run's spend: every token it moved (input, cache reads and writes, output) and its dollars when the provider says. */
export const spendOf = (usage: readonly ModelUsage[] | null): { readonly tokens: number; readonly costUsd: number | null } | undefined => {
  if (usage === null || usage.length === 0) return undefined;
  const tokens = usage.reduce((sum, model) => sum + model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens + model.outputTokens, 0);
  const costs = usage.flatMap((model) => (model.costUsd === null ? [] : [model.costUsd]));
  return { tokens, costUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0) };
};

/**
 * What the live run is doing, in words: its running calls as the fold says
 * them in flight ("Running a command"), else what it is streaming, else
 * that it works.
 */
export const workingWords = (projection: SessionProjection | undefined, runId: string | undefined): string => {
  if (!projection || runId === undefined) return "working";
  const counts: Partial<Record<ToolCategory, number>> = {};
  let thinking = false;
  let writing = false;
  for (const entry of projection.items) {
    if (entry.kind === "tool-call" && entry.runId === runId && entry.status === "running") {
      const category = classifyTool(entry.name);
      counts[category] = (counts[category] ?? 0) + 1;
    }
    if ((entry.kind === "assistant-text" || entry.kind === "assistant-thinking") && entry.runId === runId && entry.streaming) {
      if (entry.kind === "assistant-thinking") thinking = true;
      else writing = true;
    }
  }
  const calls = describeActivity(counts as ActivityCounts, true);
  if (calls !== "") return calls;
  if (writing) return "writing";
  if (thinking) return "thinking";
  return "working";
};

/**
 * Whether the account's window is out, as the hand-off recommendation says
 * it: the provider refuses a window of the account handed from (its
 * threshold's verdict), with or without another account to take the work.
 */
export const windowOut = (recommendation: HandoffRecommendation | null | undefined): boolean =>
  recommendation !== null && recommendation !== undefined && (recommendation.reason === "limit-reached" || recommendation.trigger?.verdict === "rejected");

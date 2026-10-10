import { isKnownUsageWindow, usageWindowLabel } from "@agent-harness/contracts";
import type { AccountCatalogue, AccountRecord, AccountStatusState, ContainmentLevel, HandoffRecommendation, Mode, ModelEntry, ModelUsage, UsageWindow } from "@agent-harness/contracts";
import type { UsageGauge } from "../projections/accounts.js";
import type { SessionProjection } from "../projections/session.js";
import { classifyTool, describeActivity, type ActivityCounts, type ToolCategory } from "../transcript/format.js";

/**
 * The status line's and the pickers' words as both renderers say them
 * (docs/specs/tui.md, "Status, usage, pickers"; docs/specs/gui.md, "A
 * session pane"; #147, moved here by #402): the mode's badge, the
 * containment level's, a plan window's name, reading and pressure, the
 * run's clock and spend, what a live run is doing, when the account's window
 * is out, an account's sign-in status, and a model's name. Pure. How each is
 * drawn (a bar of cells or of pixels, a colour) stays each renderer's.
 */

/** The mode as a badge: `⏵⏵` for the modes that do not stop to ask, `⏸` for those that do; bypassPermissions in capitals, the one reading that is a warning. */
export const MODE_BADGE_WORDS: Readonly<Record<Mode, string>> = {
  plan: "⏸ plan",
  acceptEdits: "⏵⏵ accept edits",
  auto: "⏸ auto",
  bypassPermissions: "⏵⏵ BYPASS",
};

/** The clamp after a mode badge: the mode asked for, lowered to the one the badge shows (CONTEXT.md, "Clamp"). */
export const clampWords = (from: Mode): string => `(clamped from ${from})`;

/**
 * The containment level as a glyph and its word: the fuller the circle, the
 * less a run may reach. `isDefault` marks a level read from the
 * environment's default rather than the session's own.
 */
export const containmentWords = (level: ContainmentLevel, isDefault: boolean): string => {
  const glyph = level === "off" ? "○ off" : level === "workspace" ? "◐ workspace" : "● no network";
  return isDefault ? `${glyph} (default)` : glyph;
};

/** A plan window's human-readable name, shared with environment notices. */
export const windowLabel = usageWindowLabel;
export const windowWords = usageWindowLabel;

/** A fraction as a whole percent: `42%`; `—` when the provider does not say. */
export const percent = (utilisation: number | null): string => (utilisation === null ? "—" : `${Math.round(utilisation * 100)}%`);

/**
 * How pressed a window is, by the desktop's thresholds: `out` when the
 * provider refuses it whatever it reads, `high` from 90%, `raised` from 75%,
 * `low` below; undefined when the provider does not say how full it is.
 */
export type Pressure = "out" | "high" | "raised" | "low";

export const pressureOf = (window: Pick<UsageWindow, "utilisation" | "verdict">): Pressure | undefined => {
  if (window.verdict === "rejected") return "out";
  if (window.utilisation === null) return undefined;
  if (window.utilisation >= 0.9) return "high";
  if (window.utilisation >= 0.75) return "raised";
  return "low";
};

/** One window of a gauge as a reading: its short name, how full it is, its percent (with `out` when refused), its pressure, and when it rolls over. */
export interface Reading {
  readonly window: string;
  readonly label: string;
  readonly utilisation: number | null;
  readonly value: string;
  readonly pressure: Pressure | undefined;
  readonly resetsAt: string | null;
}

export const readingsOf = (gauge: UsageGauge | undefined): readonly Reading[] =>
  (gauge?.windows ?? []).map((window) => ({
    window: window.window,
    label: windowLabel(window.window),
    utilisation: window.utilisation,
    value: window.verdict === "rejected" ? `${percent(window.utilisation)} out` : percent(window.utilisation),
    pressure: pressureOf(window),
    resetsAt: window.resetsAt,
  }));

/** Compact meters show only recognised windows; lists that name each window take `listedReadingsOf`. */
export const meterReadingsOf = (gauge: UsageGauge | undefined): readonly Reading[] => readingsOf(gauge).filter((reading) => isKnownUsageWindow(reading.window));

/** Whether a reading says something: how full its window is, or that the provider refuses it. */
const saysSomething = (reading: Reading): boolean => reading.utilisation !== null || reading.pressure === "out";

/**
 * A gauge's windows for a list that names each (#1893): every known window,
 * and the unknown limits that say something; the unknown ones that say
 * nothing only counted, as identical `Other limit —` rows tell a person
 * nothing. Settings > Usage and the status line's details both list these (#1951).
 */
export const listedReadingsOf = (gauge: UsageGauge | undefined): { readonly readings: readonly Reading[]; readonly silent: number } => {
  const readings = readingsOf(gauge);
  const listed = readings.filter((reading) => isKnownUsageWindow(reading.window) || saysSomething(reading));
  return { readings: listed, silent: readings.length - listed.length };
};

/** How many unknown limits a list left out for saying nothing: `2 other limits give no reading.` */
export const silentLimitsWords = (count: number): string => (count === 1 ? "1 other limit gives no reading." : `${count} other limits give no reading.`);

/**
 * The unknown limits of a one-line summary as one item: the one with a value
 * as `Other limit 37%`, several as the fullest and how many are refused
 * (`Other limits: highest 37%, 1 out`); nothing when none says how full it
 * is, as identical labels with `—` tell a person nothing.
 */
const otherLimitsWords = (readings: readonly Reading[]): string | undefined => {
  const said = readings.filter(saysSomething);
  if (said.length <= 1) return said[0] === undefined ? undefined : `${said[0].label} ${said[0].value}`;
  const read = said.flatMap((reading) => (reading.utilisation === null ? [] : [reading.utilisation]));
  const refused = said.filter((reading) => reading.pressure === "out").length;
  const parts = [...(read.length === 0 ? [] : [`highest ${percent(Math.max(...read))}`]), ...(refused === 0 ? [] : [`${refused} out`])];
  return `Other limits: ${parts.join(", ")}`;
};

/** A gauge's windows in one line: `5-hour 42% · Weekly 10%`, unknown limits folded into one item; its reason when it shows none. */
export const readingWords = (gauge: UsageGauge | undefined): string | undefined => {
  if (!gauge) return undefined;
  const readings = readingsOf(gauge);
  const others = otherLimitsWords(readings.filter((reading) => !isKnownUsageWindow(reading.window)));
  const items = [...meterReadingsOf(gauge).map((reading) => `${reading.label} ${reading.value}`), ...(others === undefined ? [] : [others])];
  return items.length === 0 ? (gauge.unavailableReason ?? undefined) : items.join(" · ");
};

/** The gauge pooling an account on its environment (`projections.usage` pools by account identity across environments); none for no account. */
export const gaugeOf = (gauges: readonly UsageGauge[], environmentId: string, accountId: string | null): UsageGauge | undefined =>
  accountId === null ? undefined : gauges.find((gauge) => gauge.accounts.some((a) => a.environmentId === environmentId && a.accountId === accountId));

/** Elapsed time on a line that redraws once a second: zero-padded past the first minute so the field holds its width. */
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
export interface Spend {
  readonly tokens: number;
  readonly costUsd: number | null;
}

export const spendOf = (usage: readonly ModelUsage[] | null): Spend | undefined => {
  if (usage === null || usage.length === 0) return undefined;
  const tokens = usage.reduce((sum, model) => sum + model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens + model.outputTokens, 0);
  const costs = usage.flatMap((model) => (model.costUsd === null ? [] : [model.costUsd]));
  return { tokens, costUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0) };
};

/** What the live run is doing, in words: its running calls as the fold says them in flight ("Running a command"), else what it streams, else that it works. */
export const workingWords = (projection: Pick<SessionProjection, "items"> | undefined, runId: string | undefined): string => {
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
 * threshold's verdict), with or without another account to take the work. A
 * window near its limit is not out.
 */
export const windowOut = (recommendation: HandoffRecommendation | null | undefined): boolean =>
  recommendation !== null && recommendation !== undefined && (recommendation.reason === "limit-reached" || recommendation.trigger?.verdict === "rejected");

/** An account's sign-in status in words. */
export const ACCOUNT_STATUS_WORDS: Readonly<Record<AccountStatusState, string>> = {
  "signed-in": "signed in",
  "signed-out": "signed out",
  expired: "sign-in expired",
  unreadable: "status unreadable",
  unavailable: "temporarily unavailable; checking again",
};

/** Who an account signs in as, in words: its identity's email, or that it has not been read yet. */
export const identityWords = (account: Pick<AccountRecord, "identity">): string => account.identity?.email ?? "not read yet";

/** The account a list starts on: the one recommended, else the session's, else the first. */
export const startingAccount = (accounts: readonly AccountRecord[], recommended: string | null | undefined, sessionAccount: string | null): number => {
  const at = accounts.findIndex((a) => a.id === (recommended ?? sessionAccount));
  if (at !== -1) return at;
  return Math.max(0, accounts.findIndex((a) => a.id === sessionAccount));
};

/**
 * The models' display names as their provider names them, the one table every
 * client reads (#1824): an alias and the full id it stands for name the same
 * model. Keys are lower case, without a dated snapshot's suffix.
 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  fable: "Fable 5.1",
  "claude-fable-5-1": "Fable 5.1",
  opus: "Opus 5.5",
  "claude-opus-5-5": "Opus 5.5",
  sonnet: "Sonnet 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  haiku: "Haiku 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
};

/** The efforts whose name is more than the word capitalised. */
const EFFORT_NAMES: Readonly<Record<string, string>> = { xhigh: "Extra high" };

/** A model's display name: the table's, else the provider's own label, else its id, never a blank. */
export const modelDisplayName = (id: string, label: string | null = null): string =>
  MODEL_DISPLAY_NAMES[id.trim().toLowerCase().replace(/-\d{8}$/, "")] ?? label ?? id;

/** An effort as a person reads it: "high" is "High". */
export const effortName = (effort: string): string => EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

/** The model and effort a session runs on, as the status line and the picker say them: "Fable 5.1 - High", or the model alone on its own effort. */
export const modelChoiceWords = (choice: { readonly model: string; readonly effort: string | null }, label: string | null = null): string => {
  const name = modelDisplayName(choice.model, label);
  return choice.effort === null ? name : `${name} - ${effortName(choice.effort)}`;
};

/** A saved choice that a read catalogue cannot take, before the next run. Both renderers show the same warning. */
export const modelChoiceWarning = (choice: { readonly model: string; readonly effort: string | null } | undefined, listed: ModelEntry | undefined, catalogueLoaded: boolean): string | undefined => {
  if (choice === undefined || !catalogueLoaded) return undefined;
  if (listed === undefined) return "This stored model is not listed for this account. Choose an available model for the next run.";
  if (choice.effort !== null && !listed.efforts.includes(choice.effort)) return "This stored effort is not listed for this model. Choose an available effort for the next run.";
  return undefined;
};

/** The line a picker says when a model is chosen for the session's next run. */
export const nextRunWords = (session: string, choice: { readonly model: string; readonly effort: string | null }, label: string | null = null): string =>
  `The next run of ${session} goes out on ${modelChoiceWords(choice, label)}${choice.effort === null ? " at its own effort" : ""}.`;

/** A model's name as a list says it: its display name with its id, or its id when the two are the same. */
export const modelName = (model: ModelEntry): string => {
  const name = modelDisplayName(model.id, model.label);
  return name === model.id ? model.id : `${name} (${model.id})`;
};

/** The models a picker lists: the account's catalogue; with no account, every account's models once each. */
export const modelsOf = (catalogues: readonly AccountCatalogue[], accountId: string | null): readonly ModelEntry[] => {
  const chosen = accountId === null ? catalogues : catalogues.filter((c) => c.accountId === accountId);
  const seen = new Set<string>();
  return chosen.flatMap((c) => c.models).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
};

/** Why a mode is greyed in the mode picker: above the connection's ceiling, or no mode can be chosen while the ceiling is not known. */
export const aboveCeilingWords = (ceiling: Mode | null): string => (ceiling === null ? "the ceiling is not known yet" : `above this connection's ceiling (${ceiling})`);

/** Hand-off between environments, which milestone 1 does not have: the reason it is absent. */
export const BETWEEN_ENVIRONMENTS = "hand-off between environments comes in milestone 2 (ADR 0005)";

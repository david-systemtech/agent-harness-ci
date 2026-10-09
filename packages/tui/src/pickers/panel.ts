import {
  ACCOUNT_STATUS_WORDS,
  BETWEEN_ENVIRONMENTS,
  NOTHING_TO_REVIEW,
  NO_PLAN_READING,
  NO_WINDOWS_READ,
  STEP_STATE_WORDS,
  aboveCeilingWords,
  countsWords,
  effortName,
  gaugeOf,
  gaugeWho,
  identityWords,
  modelName,
  needsWord,
  percent,
  pooledWords,
  readingWords,
  resetWords,
  reviewCountsWords,
  reviewDenialWords,
  reviewRunWords,
  setupReachWords,
  stepLine,
  stepNote,
  windowWords,
  type AccountsAnswer,
  type EnvironmentView,
  type ModePicker,
  type SetupView,
  type SetupStepView,
  type UsageView,
} from "@agent-harness/client-runtime";
import {
  BYPASS_SENTENCE,
  CONTAINMENT_LEVELS,
  PRODUCT_NAME,
  STEP_HINTS,
  type AccountRecord,
  type ContainmentLevel,
  type ContainmentReport,
  type Mode,
  type ModelEntry,
  type ResultOf,
  type SettingsRowId,
} from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import type { Span } from "../transcript/lines.js";
import { clockTime, nameOf } from "../view.js";
import { meterBar, meterTone } from "../status/line.js";

/**
 * The pickers and cards of `/account`, `/handoff`, `/model`, `/mode`,
 * `/containment`, `/usage`, `/review`, `/settings` and `/setup` (docs/specs/tui.md,
 * "Status, usage, pickers"; #147), as data: what each open card is, and the
 * rows and lines each draws from the runtime's projections and the answers
 * it read. Pure; `use-pickers.tsx` wires them to the runtime and the keys.
 */

/** What `/review` read: `permissions.review.list`'s answer. */
export type ReviewAnswer = ResultOf<"permissions.review.list">;

/** A text a card takes as it is typed: the characters, and the one line it said about the last try. */
export interface Typed {
  readonly text: string;
  readonly error: string | null;
}

/** The value of a setting being chosen or typed. */
export type SettingsEdit = { readonly kind: "choice"; readonly cursor: number } | ({ readonly kind: "text" } & Typed);

export type Panel =
  /**
   * `/account` or `/handoff`: the environment's accounts. `cursor` is null
   * until a key moves it: it sits on the account the environment recommends
   * handing off to, else the session's.
   */
  | { readonly kind: "accounts"; readonly purpose: "account" | "handoff"; readonly environmentId: string; readonly cursor: number | null }
  /**
   * A sign-in this card drives: the label typed for a new account (no
   * account yet), then the sign-in of `accountId` from `startedAt` on (null:
   * any of a new account's), the code typed into it.
   */
  | ({
      readonly kind: "signin";
      readonly environmentId: string;
      readonly label: string;
      readonly accountId: string | null;
      readonly startedAt: string | null;
      /** The command on its way, whose answer the keys wait for: the new account, the sign-in's start, or the code; null for none. */
      readonly sending: "add" | "start" | "code" | null;
    } & Typed)
  /** `/model`: the models of the account, then the efforts of the model chosen. */
  | { readonly kind: "models"; readonly environmentId: string; readonly accountId: string | null; readonly cursor: number; readonly model: ModelEntry | null; readonly modelCursor: number }
  | { readonly kind: "modes"; readonly environmentId: string; readonly sessionId: string; readonly cursor: number | null }
  | { readonly kind: "containment"; readonly environmentId: string; readonly sessionId: string; readonly cursor: number | null }
  | { readonly kind: "setup"; readonly environmentId: string; readonly cursor: number; readonly action: number; readonly sending: boolean; readonly checking: boolean; readonly failed: string | null }
  | { readonly kind: "usage"; readonly top: number }
  | { readonly kind: "review"; readonly environmentId: string; readonly top: number; readonly answer: ReviewAnswer | null; readonly failed: string | null }
  | {
      readonly kind: "settings";
      readonly environmentId: string;
      /** The row `/settings <id>` opened on, its keys alone; null for every row holding keys. */
      readonly row: SettingsRowId | null;
      readonly cursor: number;
      /** What `settings.get` answered, and every write's answer since; null until it answered. */
      readonly values: Readonly<Record<string, unknown>> | null;
      readonly failed: string | null;
      readonly edit: SettingsEdit | null;
    };

/** One row of a list card: its cells, dim when it cannot be chosen, with a note after them, a line under it and a heading over it. */
export interface PanelRow {
  readonly key: string;
  readonly cells: readonly Span[];
  readonly dim: boolean;
  readonly note?: Span;
  readonly under?: Span;
  /** A line over the row, which the cursor passes over: a settings row's label over the first of its keys. */
  readonly heading?: Span;
}

/** The width a column needs for its longest text, and two spaces. */
const columnOf = (texts: readonly string[]): number => Math.max(0, ...texts.map((t) => [...t].length)) + 2;
const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - [...text].length));

/** The row that adds an account: last in `/account`. */
export const ADD_ACCOUNT = "+ Add an account";
/** The row that answers hand-off between environments absent: last in `/handoff`. */
export const OTHER_ENVIRONMENT = "On another environment";

/**
 * The accounts as rows: label, identity, sign-in status, the session's
 * marked; the plan reading of each account's identity under it. `/account`
 * ends with "add an account", `/handoff` with the absent row for another
 * environment.
 */
export const accountRows = (
  accounts: readonly AccountRecord[],
  purpose: "account" | "handoff",
  context: { readonly environmentId: string; readonly usage: UsageView; readonly sessionAccount: string | null },
): readonly PanelRow[] => {
  const labels = columnOf(accounts.map((a) => a.label));
  const identities = columnOf(accounts.map(identityWords));
  const statuses = columnOf(accounts.map((a) => ACCOUNT_STATUS_WORDS[a.status.state]));
  const rows = accounts.map((account): PanelRow => {
    const gauge = gaugeOf(context.usage.gauges, context.environmentId, account.id);
    const reading = readingWords(gauge);
    return {
      key: account.id,
      cells: [
        { text: pad(account.label, labels), bold: true },
        { text: pad(identityWords(account), identities), dim: account.identity === null },
        { text: pad(ACCOUNT_STATUS_WORDS[account.status.state], statuses), ...(account.status.state !== "signed-in" && { color: TERMINAL_ROLES.warning }) },
      ],
      dim: false,
      ...(account.id === context.sessionAccount && { note: { text: "this session", dim: true } }),
      ...(reading !== undefined && { under: { text: `    ${reading}`, dim: true } }),
    };
  });
  return purpose === "account"
    ? [...rows, { key: "add", cells: [{ text: ADD_ACCOUNT }], dim: false }]
    : [...rows, { key: "elsewhere", cells: [{ text: OTHER_ENVIRONMENT }], dim: true, note: { text: "absent", dim: true }, under: { text: `    ${BETWEEN_ENVIRONMENTS}`, dim: true } }];
};

export const modelRows = (models: readonly ModelEntry[], current: string | null): readonly PanelRow[] => {
  const names = columnOf(models.map(modelName));
  return models.map((model) => ({
    key: model.id,
    cells: [{ text: pad(modelName(model), names) }, { text: model.efforts.length > 0 ? model.efforts.map(effortName).join(" · ") : "no effort levels", dim: model.efforts.length === 0 }],
    dim: false,
    ...(model.id === current && { note: { text: "this session", dim: true } }),
  }));
};

/** A model's efforts as rows, the model's own first; `current` the session's (null: the model's own), undefined when the session is not on the model. */
export const effortRows = (model: ModelEntry, current: string | null | undefined): readonly PanelRow[] => [
  { key: "", cells: [{ text: "the model's own" }], dim: false, ...(current === null && { note: { text: "this session", dim: true } }) },
  ...model.efforts.map((effort) => ({ key: effort, cells: [{ text: effortName(effort) }], dim: false, ...(effort === current && { note: { text: "this session", dim: true } }) })),
];

/** The modes, each above the connection's ceiling dim with the ceiling named; the session's marked. */
export const modeRows = (picker: ModePicker, current: Mode | null): readonly PanelRow[] => {
  const names = columnOf(picker.modes.map((m) => m.mode));
  return picker.modes.map(({ mode, allowed }) => ({
    key: mode,
    cells: [{ text: pad(mode, names) }],
    dim: !allowed,
    ...(!allowed
      ? { note: { text: aboveCeilingWords(picker.ceiling), dim: true } }
      : mode === current && { note: { text: "this session", dim: true } }),
  }));
};

/** The line under the mode picker while its cursor is on bypassPermissions: the permissions spec's sentence. */
export const modeFooter = (mode: Mode | undefined): string | undefined => (mode === "bypassPermissions" ? BYPASS_SENTENCE : undefined);

/**
 * The containment levels, each the probe cannot enforce dim with its
 * reason; the session's own marked, or the default's when the terminal
 * knows no level of the session's own.
 */
export const containmentRows = (report: ContainmentReport | undefined, own: ContainmentLevel | undefined, fallback: ContainmentLevel | undefined): readonly PanelRow[] => {
  const names = columnOf([...CONTAINMENT_LEVELS]);
  return CONTAINMENT_LEVELS.map((level) => {
    const availability = report?.levels.find((l) => l.level === level);
    const unavailable = availability?.available === false ? availability.reason : undefined;
    const marked = own !== undefined ? (own === level ? "this session" : undefined) : fallback === level ? "the default" : undefined;
    return {
      key: level,
      cells: [{ text: pad(level, names) }],
      dim: unavailable !== undefined,
      ...(unavailable !== undefined
        ? { note: { text: `not available here: ${unavailable}`, dim: true } }
        : marked !== undefined && { note: { text: marked, dim: true } }),
    };
  });
};

/** `/usage`: each gauge's identity and the accounts it pools, then each window with its bar, reset (its day counted from `now`) and verdict; the reason when it has none. */
export const usageLines = (
  usage: UsageView,
  views: readonly EnvironmentView[],
  accounts: (environmentId: string) => AccountsAnswer | undefined,
  cells: number,
  now: Date,
): readonly (readonly Span[])[] => {
  const name = (environmentId: string) => {
    const view = views.find((v) => v.environmentId === environmentId);
    return view ? nameOf(view) : "an environment";
  };
  const label = (environmentId: string, accountId: string) => accounts(environmentId)?.value?.find((a) => a.id === accountId)?.label ?? accountId;
  const lines: (readonly Span[])[] = [];
  for (const gauge of usage.gauges) {
    const pooled = gauge.accounts.map((a) => pooledWords(label(a.environmentId, a.accountId), name(a.environmentId))).join(", ");
    lines.push([{ text: gaugeWho(gauge), bold: true }, { text: ` · ${pooled}`, dim: true }]);
    if (gauge.windows.length === 0) lines.push([{ text: `  ${gauge.unavailableReason ?? NO_WINDOWS_READ}`, dim: true }]);
    const words = columnOf(gauge.windows.map((w) => windowWords(w.window)));
    for (const window of gauge.windows) {
      const tone = meterTone(window);
      const reset = resetWords(window.resetsAt, now);
      lines.push([
        { text: `  ${pad(windowWords(window.window), words)}` },
        ...(window.utilisation !== null && cells > 0 ? [{ text: `${meterBar(window.utilisation, cells)} `, ...(tone !== undefined && { color: tone }) }] : []),
        { text: window.verdict === "rejected" ? `${percent(window.utilisation)} out` : percent(window.utilisation), ...(tone !== undefined && { color: tone }), bold: tone === TERMINAL_ROLES.danger },
        { text: reset === undefined ? "" : `  ${reset}`, dim: true },
      ]);
    }
  }
  for (const answer of usage.environments) if (answer.error) lines.push([{ text: `${name(answer.environmentId)}: ${answer.error.message}`, color: TERMINAL_ROLES.warning }]);
  if (lines.length === 0) lines.push([{ text: NO_PLAN_READING, dim: true }]);
  return lines;
};

/** `/review`: each run, newest first: when, the session, who ran it, attended or not, its mode and containment; its calls counted; each denial. */
export const reviewLines = (answer: ReviewAnswer, titleOf: (sessionId: string) => string | undefined): readonly (readonly Span[])[] => {
  if (answer.runs.length === 0) return [[{ text: NOTHING_TO_REVIEW, dim: true }]];
  return answer.runs.flatMap((run): (readonly Span[])[] => [
    [
      { text: `${clockTime(run.ranAt)} `, dim: true },
      { text: titleOf(run.sessionId) ?? run.sessionId, bold: true },
      { text: ` · ${reviewRunWords(run)}` },
    ],
    [{ text: `      ${reviewCountsWords(run.counts)}`, dim: true }],
    ...run.denials.map((denial): readonly Span[] => [{ text: `      ${reviewDenialWords(denial)}`, color: TERMINAL_ROLES.warning }]),
  ]);
};

/** Counts, reach and the pointer to the fix under the Set up health rows (setup-copy.md §4.5). */
export const setupLines = (view: SetupView, name: string, checking: boolean, failed: string | null, live: boolean): readonly (readonly Span[])[] => {
  const reach = setupReachWords(view.reach, name);
  return [
    [{ text: countsWords(view.counts) }],
    ...(reach === undefined ? [] : [[{ text: reach, color: TERMINAL_ROLES.warning }]]),
    ...(checking ? [[{ text: "Checking Set up…", dim: true }]] : []),
    ...(failed === null ? [] : [[{ text: `${PRODUCT_NAME} could not check ${name}. Run /setup to try again.`, color: TERMINAL_ROLES.warning }], [{ text: `Details: ${failed}`, dim: true }]]),
    ...(!live ? [[{ text: "Live Set up updates are unavailable on this environment; /setup checks again.", dim: true }]] : []),
    [{ text: "Press Enter on a step to run its fix, or open Set up in the desktop app.", dim: true }],
  ];
};

/** The header follows the session's environment, independently of the checklist card (setup-copy.md §4.5). */
export const setupHeader = (view: SetupView, name: string): string | undefined => {
  const { done, registered, needsAttention, attention } = view.counts;
  if (needsAttention === 0) return undefined;
  const names = view.steps.filter((step) => attention.includes(step.id)).map((step) => step.label).join(", ");
  return `Set up on ${name}: ${done} of ${registered} done, ${needsAttention} ${needsWord(needsAttention)} a fix (${names}).`;
};

/** A step's line, and beneath it when it was checked, or that it may be out of date: `name` is the environment's. */
export const setupStepWords = (step: SetupStepView, now: Date, name: string): string => {
  const note = stepNote(step, now, name);
  return note === undefined ? stepLine(step, now) : `${stepLine(step, now)} ${note}`;
};

/** One selectable health line per step this environment registers, on the environment `name`. */
export const setupRows = (view: SetupView, now: Date, name: string): readonly PanelRow[] => view.steps.filter((step) => step.registered).map((step) => ({
  key: step.id,
  cells: [setupStepSpan(step, now, name)],
  under: { text: `  ${STEP_HINTS[step.id]}`, dim: true },
  dim: step.result?.state === "skipped",
}));

const setupStepSpan = (step: SetupStepView, now: Date, name: string): Span => {
  const state = step.result?.state;
  if (state === undefined) return { text: `${step.label}: ${stepLine(step, now)}`, dim: true };
  const attention = state === "needs-attention";
  return {
    text: `${attention ? "!" : state === "done" ? "●" : "○"} ${step.label}: ${STEP_STATE_WORDS[state]}${attention || state === "pending" || step.pending || step.result?.stale || step.result?.olderThanCadence ? ` — ${setupStepWords(step, now, name)}` : ""}`,
    dim: state === "skipped",
    ...(attention && { color: TERMINAL_ROLES.warning }),
  };
};

import type { AccountsAnswer, EnvironmentView, ModePicker, UsageView } from "@agent-harness/client-runtime";
import {
  BYPASS_SENTENCE,
  CONTAINMENT_LEVELS,
  type AccountCatalogue,
  type AccountRecord,
  type AccountStatusState,
  type ContainmentLevel,
  type ContainmentReport,
  type Mode,
  type ModelEntry,
  type ResultOf,
  type SettingsRowId,
  type SignIn,
} from "@agent-harness/contracts";
import { gaugeOf } from "../transcript/plan.js";
import type { Span } from "../transcript/lines.js";
import { clockTime, nameOf } from "../view.js";
import { meterBar, meterTone, percent, readingWords, windowWords } from "../status/line.js";

/**
 * The pickers and cards of `/account`, `/handoff`, `/model`, `/mode`,
 * `/containment`, `/usage`, `/review` and `/settings` (docs/specs/tui.md,
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

const STATUS_WORDS: Readonly<Record<AccountStatusState, string>> = {
  "signed-in": "signed in",
  "signed-out": "signed out",
  expired: "sign-in expired",
  unreadable: "status unreadable",
};

/** The width a column needs for its longest text, and two spaces. */
const columnOf = (texts: readonly string[]): number => Math.max(0, ...texts.map((t) => [...t].length)) + 2;
const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - [...text].length));

/** The row that adds an account: last in `/account`. */
export const ADD_ACCOUNT = "+ Add an account";
/** The row that answers hand-off between environments absent: last in `/handoff`. */
export const OTHER_ENVIRONMENT = "On another environment";
export const BETWEEN_ENVIRONMENTS = "hand-off between environments comes in milestone 2 (ADR 0005)";

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
  const identities = columnOf(accounts.map((a) => a.identity?.email ?? "not read yet"));
  const statuses = columnOf(accounts.map((a) => STATUS_WORDS[a.status.state]));
  const rows = accounts.map((account): PanelRow => {
    const gauge = gaugeOf(context.usage.gauges, context.environmentId, account.id);
    const reading = readingWords(gauge);
    return {
      key: account.id,
      cells: [
        { text: pad(account.label, labels), bold: true },
        { text: pad(account.identity?.email ?? "not read yet", identities), dim: account.identity === null },
        { text: pad(STATUS_WORDS[account.status.state], statuses), ...(account.status.state !== "signed-in" && { color: "yellow" }) },
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

/** The account a list starts on: the one recommended, else the session's, else the first. */
export const startingAccount = (accounts: readonly AccountRecord[], recommended: string | null | undefined, sessionAccount: string | null): number => {
  const at = accounts.findIndex((a) => a.id === (recommended ?? sessionAccount));
  if (at !== -1) return at;
  return Math.max(0, accounts.findIndex((a) => a.id === sessionAccount));
};

/** A model's name as a list says it: its label with its id, or its id. */
export const modelName = (model: ModelEntry): string => (model.label !== null ? `${model.label} (${model.id})` : model.id);

/** The catalogue a picker lists: the account's; with no account, every account's models once each. */
export const modelsOf = (catalogues: readonly AccountCatalogue[], accountId: string | null): readonly ModelEntry[] => {
  const chosen = accountId === null ? catalogues : catalogues.filter((c) => c.accountId === accountId);
  const seen = new Set<string>();
  return chosen.flatMap((c) => c.models).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
};

export const modelRows = (models: readonly ModelEntry[], current: string | null): readonly PanelRow[] => {
  const names = columnOf(models.map(modelName));
  return models.map((model) => ({
    key: model.id,
    cells: [{ text: pad(modelName(model), names) }, { text: model.efforts.length > 0 ? model.efforts.join(" · ") : "no effort levels", dim: model.efforts.length === 0 }],
    dim: false,
    ...(model.id === current && { note: { text: "this session", dim: true } }),
  }));
};

/** A model's efforts as rows, the model's own first; `current` the session's (null: the model's own), undefined when the session is not on the model. */
export const effortRows = (model: ModelEntry, current: string | null | undefined): readonly PanelRow[] => [
  { key: "", cells: [{ text: "the model's own" }], dim: false, ...(current === null && { note: { text: "this session", dim: true } }) },
  ...model.efforts.map((effort) => ({ key: effort, cells: [{ text: effort }], dim: false, ...(effort === current && { note: { text: "this session", dim: true } }) })),
];

/** The modes, each above the connection's ceiling dim with the ceiling named; the session's marked. */
export const modeRows = (picker: ModePicker, current: Mode | null): readonly PanelRow[] => {
  const names = columnOf(picker.modes.map((m) => m.mode));
  return picker.modes.map(({ mode, allowed }) => ({
    key: mode,
    cells: [{ text: pad(mode, names) }],
    dim: !allowed,
    ...(!allowed
      ? { note: { text: picker.ceiling === null ? "the ceiling is not known yet" : `above this connection's ceiling (${picker.ceiling})`, dim: true } }
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

/** `/usage`: each gauge's identity and the accounts it pools, then each window with its bar, reset and verdict; the reason when it has none. */
export const usageLines = (
  usage: UsageView,
  views: readonly EnvironmentView[],
  accounts: (environmentId: string) => AccountsAnswer | undefined,
  cells: number,
): readonly (readonly Span[])[] => {
  const name = (environmentId: string) => {
    const view = views.find((v) => v.environmentId === environmentId);
    return view ? nameOf(view) : "an environment";
  };
  const label = (environmentId: string, accountId: string) => accounts(environmentId)?.value?.find((a) => a.id === accountId)?.label ?? accountId;
  const lines: (readonly Span[])[] = [];
  for (const gauge of usage.gauges) {
    const who = gauge.identity?.email ?? "an account never read";
    const pooled = gauge.accounts.map((a) => `${label(a.environmentId, a.accountId)} on ${name(a.environmentId)}`).join(", ");
    lines.push([{ text: who, bold: true }, { text: ` · ${pooled}`, dim: true }]);
    if (gauge.windows.length === 0) lines.push([{ text: `  ${gauge.unavailableReason ?? "No plan windows read yet."}`, dim: true }]);
    const words = columnOf(gauge.windows.map((w) => windowWords(w.window)));
    for (const window of gauge.windows) {
      const tone = meterTone(window);
      lines.push([
        { text: `  ${pad(windowWords(window.window), words)}` },
        ...(window.utilisation !== null && cells > 0 ? [{ text: `${meterBar(window.utilisation, cells)} `, ...(tone !== undefined && { color: tone }) }] : []),
        { text: window.verdict === "rejected" ? `${percent(window.utilisation)} out` : percent(window.utilisation), ...(tone !== undefined && { color: tone }), bold: tone === "red" },
        { text: window.resetsAt !== null ? `  resets ${clockTime(window.resetsAt)}` : "", dim: true },
      ]);
    }
  }
  for (const answer of usage.environments) if (answer.error) lines.push([{ text: `${name(answer.environmentId)}: ${answer.error.message}`, color: "yellow" }]);
  if (lines.length === 0) lines.push([{ text: "No account has a plan reading yet.", dim: true }]);
  return lines;
};

/** `/review`: each run, newest first: when, the session, who ran it, attended or not, its mode and containment; its calls counted; each denial. */
export const reviewLines = (answer: ReviewAnswer, titleOf: (sessionId: string) => string | undefined): readonly (readonly Span[])[] => {
  if (answer.runs.length === 0) return [[{ text: "Nothing to review: no run since the review was last seen.", dim: true }]];
  return answer.runs.flatMap((run): (readonly Span[])[] => {
    const who = run.actor.name !== null ? `${run.actor.kind} ${run.actor.name}` : run.actor.kind;
    const mode = run.mode.clamped ? `${run.mode.effective} (clamped from ${run.mode.requested ?? "the default"})` : run.mode.effective;
    const { counts } = run;
    return [
      [
        { text: `${clockTime(run.ranAt)} `, dim: true },
        { text: titleOf(run.sessionId) ?? run.sessionId, bold: true },
        { text: ` · ${who} · ${run.attended ? "attended" : "unattended"} · ${mode} · ${run.containment.effective}` },
      ],
      [
        {
          text: `      ${counts.toolCalls} call${counts.toolCalls === 1 ? "" : "s"}: ${counts.autoApproved} auto-approved, ${counts.denied} denied, ${counts.answeredByPerson} by a person, ${counts.expired} expired`,
          dim: true,
        },
      ],
      ...run.denials.map((denial): readonly Span[] => [{ text: `      denied ${denial.tool ?? "a prompt"}: ${denial.summary} (${denial.decidedBy}: ${denial.reason})`, color: "yellow" }]),
    ];
  });
};

/** A sign-in's end in one line: done, failed, expired or cancelled. */
export const signInEnd = (signIn: SignIn, label: string, environment: string): string | undefined => {
  switch (signIn.state) {
    case "done":
      return `${label} is signed in on ${environment}.`;
    case "failed":
      return `The sign-in of ${label} failed: ${signIn.error ?? "the provider's CLI gave up"}.`;
    case "expired":
      return `The sign-in of ${label} expired: ${signIn.error ?? "no code came within ten minutes"}.`;
    case "cancelled":
      return `The sign-in of ${label} was cancelled.`;
    default:
      return undefined;
  }
};

/**
 * The fallback command for a terminal on the environment's machine
 * (ADR 0018): PowerShell where the account's directory is a Windows path (a
 * drive letter or a backslash), the POSIX shell's otherwise.
 */
export const fallbackOf = (signIn: SignIn, directory: string | undefined): string =>
  directory !== undefined && (/^[a-z]:/i.test(directory) || directory.includes("\\")) ? signIn.fallback.powershell : signIn.fallback.posix;
